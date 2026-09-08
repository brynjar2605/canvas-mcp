import { z } from "zod";
import { defineTool } from "./_types.js";
import { currentCourses, resolveCourse } from "../canvas/courses.js";
import { getGrades, type CourseGrade } from "../canvas/grades.js";

function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}

export const tool = defineTool({
  name: "get_grades",
  description:
    "Your grade per course. RU hides Canvas course totals from students, so this normally reports a " +
    "percentage computed from your graded assignments (score ÷ points possible) and says so. For the " +
    "individual assignment scores behind it, use list_assignments with filter: 'graded'.",
  inputSchema: {
    course: z
      .union([z.string(), z.number()])
      .optional()
      .describe(
        'Course slug like "thyd", full code like "T-603-THYD", numeric Canvas id, or a distinctive word from the course name. Omit for all current courses.',
      ),
  },
  handler: async (input, ctx) => {
    const courses = input.course
      ? [await resolveCourse(ctx.client, input.course)]
      : await currentCourses(ctx.client);
    if (courses.length === 0) {
      return "No current courses found.";
    }
    const grades = await getGrades(ctx.client, courses);
    if (grades.length === 0) {
      return "No grade data available.";
    }

    // RU hides `current_score` for essentially every course we've seen; when every course in this
    // list lacks a Canvas total, lead with a computed-from-assignments view instead of a column of "-".
    if (grades.every((g: CourseGrade) => g.currentScore === null)) {
      const header =
        "Course totals are hidden by RU; showing computed score from graded assignments.\n\n" +
        "| course | graded | computed % |\n| --- | --- | --- |";
      const rows = grades.map((g) => {
        const graded = `${g.gradedCount ?? 0}/${g.totalCount ?? 0}`;
        const computed = g.fallbackPercent != null ? pct(g.fallbackPercent) : "-";
        return `| ${g.courseSlug} | ${graded} | ${computed} |`;
      });
      const footer = "Computed from graded assignments only; ungraded work is excluded, so this is not a projected final grade.";
      return [header, ...rows, "", footer].join("\n");
    }

    const header = "| slug | course | current score | current grade | final score |\n| --- | --- | --- | --- | --- |";
    const rows = grades.map((g) => {
      const currentScoreCell =
        g.currentScore ?? (g.fallbackPercent != null ? `~${pct(g.fallbackPercent)} (computed)` : "-");
      return `| ${g.courseSlug} | ${g.courseName} | ${currentScoreCell} | ${g.currentGrade ?? "-"} | ${g.finalScore ?? "-"} |`;
    });
    return [header, ...rows].join("\n");
  },
});
