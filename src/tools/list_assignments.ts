import { z } from "zod";
import { defineTool } from "./_types.js";
import { currentCourses, resolveCourse } from "../canvas/courses.js";
import { listAssignments, type AssignmentFilter, type AssignmentSummary } from "../canvas/assignments.js";
import { formatReykjavikDateTime } from "../canvas/calendar.js";

const FILTERS = ["upcoming", "past", "missing", "graded", "all"] as const;

function formatAssignmentLine(a: AssignmentSummary): string {
  const due = a.dueAt ? `due ${formatReykjavikDateTime(a.dueAt)}` : "no due date";
  const points = a.pointsPossible !== null ? `${a.pointsPossible} pts` : "no points";

  let status: string;
  if (a.missing) {
    status = "MISSING";
  } else if (a.score !== null) {
    status = `score ${a.score}${a.pointsPossible !== null ? `/${a.pointsPossible}` : ""}${a.grade ? ` (${a.grade})` : ""}`;
  } else if (a.submitted) {
    status = "submitted ✓";
  } else {
    status = "not submitted";
  }
  if (a.late) status += ", late";

  return `- [${a.courseSlug}] ${a.name} — ${due} — ${points} — ${status} (id ${a.id})`;
}

export const tool = defineTool({
  name: "list_assignments",
  description:
    "List assignments for one course or all current courses. Filter by upcoming/past/missing/graded/all (default all).",
  inputSchema: {
    course: z.string().optional().describe("Course slug, code, or id. Omit for all current-semester courses."),
    filter: z.enum(FILTERS).optional().describe("upcoming | past | missing | graded | all (default all)."),
    days: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Day window for the 'upcoming' filter (default 30) and, if given, also bounds 'past'."),
  },
  handler: async (input, ctx) => {
    const courses = input.course
      ? [await resolveCourse(ctx.client, input.course)]
      : await currentCourses(ctx.client);
    if (courses.length === 0) {
      return "No current courses found.";
    }

    const filter: AssignmentFilter = input.filter ?? "all";
    const sections: string[] = [];
    for (const course of courses) {
      const assignments = await listAssignments(ctx.client, course, filter, input.days);
      const heading = `## ${course.slug} (${course.code})`;
      if (assignments.length === 0) {
        sections.push(`${heading}\nNo ${filter === "all" ? "" : `${filter} `}assignments.`);
      } else {
        sections.push([heading, ...assignments.map(formatAssignmentLine)].join("\n"));
      }
    }
    return sections.join("\n\n");
  },
});
