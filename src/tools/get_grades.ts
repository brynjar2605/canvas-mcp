import { defineTool } from "./_types.js";
import { currentCourses } from "../canvas/courses.js";
import { getGrades } from "../canvas/grades.js";

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
    const header = "| slug | course | current score | current grade | final score |\n| --- | --- | --- | --- | --- |";
    const rows = grades.map(
      (g) =>
        `| ${g.courseSlug} | ${g.courseName} | ${g.currentScore ?? "-"} | ${g.currentGrade ?? "-"} | ${g.finalScore ?? "-"} |`,
    );
    return [header, ...rows].join("\n");
  },
});
