import { z } from "zod";
import { defineTool } from "./_types.js";
import { resolveCourse } from "../canvas/courses.js";
import { formatScoreWithGrade, getAssignment, isInClassOnly } from "../canvas/assignments.js";
import { formatReykjavikDateTime } from "../canvas/calendar.js";

export const tool = defineTool({
  name: "get_assignment",
  description: "Full detail for one assignment: description (markdown), rubric, attachments, submission state.",
  inputSchema: {
    course: z
      .union([z.string(), z.number()])
      .describe(
        'Course slug like "thyd", full code like "T-603-THYD", numeric Canvas id, or a distinctive word from the course name.',
      ),
    assignment_id: z.number().int().describe("Canvas assignment id (from list_assignments or get_upcoming)."),
  },
  handler: async (input, ctx) => {
    const course = await resolveCourse(ctx.client, input.course);
    const a = await getAssignment(ctx.client, course, input.assignment_id);

    const lines: string[] = [`# ${a.name} (${course.slug})`, ""];
    lines.push(`- Due: ${a.dueAt ? formatReykjavikDateTime(a.dueAt) : "no due date"}`);
    if (a.unlockAt) lines.push(`- Unlocks: ${formatReykjavikDateTime(a.unlockAt)}`);
    if (a.lockAt) lines.push(`- Locks: ${formatReykjavikDateTime(a.lockAt)}`);
    lines.push(`- Points: ${a.pointsPossible ?? "none"}`);
    lines.push(`- Submission types: ${a.submissionTypes.length > 0 ? a.submissionTypes.join(", ") : "none"}`);

    // "submitted" would misleadingly imply an online submission — this RU pattern (in-class
    // work graded with no online submission_type) was graded in class instead.
    let statusBase: string;
    if (a.missing) {
      statusBase = "MISSING";
    } else if (a.submitted && isInClassOnly(a.submissionTypes) && a.score !== null) {
      statusBase = "graded in class";
    } else if (a.submitted) {
      statusBase = "submitted";
    } else {
      statusBase = "not submitted";
    }
    let status = statusBase;
    if (a.submittedAt) status += ` (${formatReykjavikDateTime(a.submittedAt)})`;
    if (a.late) status += ", late";
    lines.push(`- Status: ${status}`);

    if (a.score !== null) {
      lines.push(`- Score: ${formatScoreWithGrade(a.score, a.pointsPossible, a.grade)}`);
    }
    lines.push(`- Link: ${a.htmlUrl}`);

    lines.push("", "## Description");
    lines.push(a.descriptionMarkdown.trim().length > 0 ? a.descriptionMarkdown.trim() : "(no description)");

    if (a.rubric.length > 0) {
      lines.push("", "## Rubric");
      for (const r of a.rubric) {
        lines.push(`- ${r.description || "(no description)"}${r.points !== null ? ` (${r.points} pts)` : ""}`);
      }
    }

    if (a.attachments && a.attachments.length > 0) {
      // The description above already links each of these (as a markdown link) — this section
      // exists to surface file_id (for download_file), not to repeat the url a second time.
      lines.push("", "## Attachments");
      for (const att of a.attachments) {
        const fileIdPart = att.fileId !== null ? ` — file_id ${att.fileId}` : "";
        lines.push(`- ${att.name}${fileIdPart}`);
      }
    }

    return lines.join("\n");
  },
});
