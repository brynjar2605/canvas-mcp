import { defineTool } from "./_types.js";
import { currentCourses } from "../canvas/courses.js";
import { getGrades, type CourseGrade } from "../canvas/grades.js";

function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}

export const tool = defineTool({
  name: "get_grades",
  description: "Current grade per current-semester course.",
  inputSchema: {},
  handler: async (_input, ctx) => {
    const courses = await currentCourses(ctx.client);
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
        "| course | graded | computed % | canvas total |\n| --- | --- | --- | --- |";
      const rows = grades.map((g) => {
        const graded = `${g.gradedCount ?? 0}/${g.totalCount ?? 0}`;
        const computed = g.fallbackPercent != null ? pct(g.fallbackPercent) : "-";
        return `| ${g.courseSlug} | ${graded} | ${computed} | - |`;
      });
      return [header, ...rows].join("\n");
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
