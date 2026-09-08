import { z } from "zod";
import { defineTool } from "./_types.js";
import { resolveCourse } from "../canvas/courses.js";
import { getAssignment } from "../canvas/assignments.js";
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

    let status = a.missing ? "MISSING" : a.submitted ? "submitted" : "not submitted";
    if (a.submittedAt) status += ` (${formatReykjavikDateTime(a.submittedAt)})`;
    if (a.late) status += ", late";
    lines.push(`- Status: ${status}`);

    if (a.score !== null) {
      const scoreText = `${a.score}${a.pointsPossible !== null ? `/${a.pointsPossible}` : ""}`;
      const gradePart = a.grade && a.grade !== scoreText ? ` (${a.grade})` : "";
      lines.push(`- Score: ${scoreText}${gradePart}`);
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
      lines.push("", "## Attachments");
      for (const att of a.attachments) {
        const fileIdPart = att.fileId !== null ? ` (file_id ${att.fileId})` : "";
        lines.push(`- [${att.name}](${att.url})${fileIdPart}`);
      }
    }

    return lines.join("\n");
  },
});
