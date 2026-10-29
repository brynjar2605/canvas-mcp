import { z } from "zod";
import { defineTool } from "./_types.js";
import { currentSemesterOf, listCourses, type CourseInfo } from "../canvas/courses.js";

/** "Upcoming (Vorönn 2027, önn 6): star — …" for courses in semesters after the current one. */
function upcomingFooter(all: CourseInfo[], current: number | null): string | null {
  if (current === null) return null;
  const bySem = new Map<number, CourseInfo[]>();
  for (const c of all) {
    if (c.semester !== null && c.semester > current) bySem.set(c.semester, [...(bySem.get(c.semester) ?? []), c]);
  }
  if (bySem.size === 0) return null;
  const groups = [...bySem.entries()]
    .sort(([a], [b]) => a - b)
    .map(([sem, cs]) => `(${cs[0]!.term ?? "?"}, önn ${sem}): ${cs.map((c) => c.slug).join(", ")}`);
  return `Upcoming ${groups.join("; ")} — pass include_past: true to list every semester.`;
}

export const tool = defineTool({
  name: "list_courses",
  description:
    "List Canvas courses. By default only the current semester's courses (the term in progress today, by Canvas " +
    "term dates), with a footer naming any upcoming-semester courses; pass include_past for every semester.",
  inputSchema: {
    include_past: z
      .boolean()
      .optional()
      .describe("Include all other semesters as well — past and upcoming — not just the current one. Default false."),
  },
  handler: async (input, ctx) => {
    const all = await listCourses(ctx.client);
    const sem = currentSemesterOf(all);
    const courses = input.include_past ? all : all.filter((c) => c.semester === sem);
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
    const footer = input.include_past ? null : upcomingFooter(all, sem);
    return [header, ...rows].join("\n") + (footer ? `\n\n${footer}` : "");
  },
});
