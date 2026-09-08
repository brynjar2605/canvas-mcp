import { z } from "zod";
import { defineTool } from "./_types.js";
import { currentCourses, listCourses } from "../canvas/courses.js";

export const tool = defineTool({
  name: "list_courses",
  description:
    "List Canvas courses. By default only the current (highest-derived-semester) courses; pass include_past for full history.",
  inputSchema: {
    include_past: z
      .boolean()
      .optional()
      .describe("Include past semesters as well, not just the current one. Default false."),
  },
  handler: async (input, ctx) => {
    const courses = input.include_past ? await listCourses(ctx.client) : await currentCourses(ctx.client);
    if (courses.length === 0) {
      return (
        "No courses matched. Only real RU courses (code like T-603-THYD) are listed; announcement and video " +
        "shells are filtered out. Try include_past: true, or check that CANVAS_TOKEN belongs to the right account."
      );
    }
    const header = "| id | slug | code | name | term | önn |\n| --- | --- | --- | --- | --- | --- |";
    const rows = courses.map(
      (c) => `| ${c.id} | ${c.slug} | ${c.code} | ${c.name} | ${c.term ?? "-"} | ${c.semester ?? "-"} |`,
    );
    return [header, ...rows].join("\n");
  },
});
