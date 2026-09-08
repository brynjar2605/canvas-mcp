import { z } from "zod";
import { defineTool } from "./_types.js";
import { currentCourses, resolveCourse } from "../canvas/courses.js";
import { listAssignments, type AssignmentFilter, type AssignmentSummary } from "../canvas/assignments.js";
import { formatReykjavikDateTime } from "../canvas/calendar.js";

const FILTERS = ["upcoming", "past", "missing", "graded", "all"] as const;

/** RU regularly grades "none"/"on_paper" assignments (in-class work, no online submission) with a score. */
function isInClassOnly(submissionTypes: string[] | undefined): boolean {
  if (!submissionTypes || submissionTypes.length === 0) return false;
  return submissionTypes.every((t) => t === "none" || t === "on_paper");
}

function formatAssignmentLine(a: AssignmentSummary): string {
  const due = a.dueAt ? `due ${formatReykjavikDateTime(a.dueAt)}` : "no due date";
  const points = a.pointsPossible !== null ? `${a.pointsPossible} pts` : "no points";

  let status: string;
  if (a.missing) {
    status = "MISSING";
  } else if (a.score !== null) {
    const rawScoreText = `${a.score}${a.pointsPossible !== null ? `/${a.pointsPossible}` : ""}`;
    const gradePart = a.grade && a.grade !== rawScoreText ? ` (${a.grade})` : "";
    const scoreText = `score ${rawScoreText}${gradePart}`;
    // "submitted ✓" would misleadingly imply an online submission — this was graded in class instead.
    status = isInClassOnly(a.submissionTypes) ? `${scoreText} (graded in class)` : scoreText;
  } else if (a.submitted) {
    status = "submitted ✓";
  } else {
    status = "not submitted";
  }
  if (a.late) status += ", late";

  return `- [${a.courseSlug}] ${a.name} — ${due} — ${points} — ${status} (assignment_id ${a.id})`;
}

export const tool = defineTool({
  name: "list_assignments",
  description:
    "Assignments for one course (or all current courses), with due date, points, submitted/graded state, " +
    "score, and the assignment_id needed by get_assignment. filter: 'upcoming' (due in the next `days`, default " +
    "30), 'past', 'missing', 'graded' (has a score — use this for 'did I pass X?'), or 'all' (default). Does " +
    "not include lectures or calendar events — use get_upcoming for those.",
  inputSchema: {
    course: z
      .union([z.string(), z.number()])
      .optional()
      .describe(
        'Course slug like "thyd", full code like "T-603-THYD", numeric Canvas id, or a distinctive word from the course name. Omit for all current-semester courses.',
      ),
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
