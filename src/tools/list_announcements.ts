import { z } from "zod";
import { defineTool } from "./_types.js";
import { currentCourses, resolveCourse } from "../canvas/courses.js";
import { DEFAULT_ANNOUNCEMENT_DAYS, listAnnouncements } from "../canvas/announcements.js";
import { formatReykjavikDateTime } from "../canvas/calendar.js";

const BODY_LIMIT = 1500;

export const tool = defineTool({
  name: "list_announcements",
  description: "List course announcements from the last N days (default 30), newest first.",
  inputSchema: {
    course: z.string().optional().describe("Course slug, code, or id. Omit for all current-semester courses."),
    days: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`How many days back to look (default ${DEFAULT_ANNOUNCEMENT_DAYS}).`),
  },
  handler: async (input, ctx) => {
    const courses = input.course
      ? [await resolveCourse(ctx.client, input.course)]
      : await currentCourses(ctx.client);
    if (courses.length === 0) {
      return "No current courses found.";
    }

    const days = input.days ?? DEFAULT_ANNOUNCEMENT_DAYS;
    const announcements = await listAnnouncements(ctx.client, courses, days);
    if (announcements.length === 0) {
      return `No announcements in the last ${days} days.`;
    }

    const blocks = announcements.map((a) => {
      const date = a.postedAt ? formatReykjavikDateTime(a.postedAt) : "no date";
      let body = a.bodyMarkdown.trim();
      let trimmedNote = "";
      if (body.length > BODY_LIMIT) {
        body = `${body.slice(0, BODY_LIMIT)}...`;
        trimmedNote = "\n\n_(body trimmed)_";
      }
      return `## [${a.courseSlug}] ${a.title} — ${date}\n\n${body || "(no body)"}${trimmedNote}`;
    });
    return blocks.join("\n\n---\n\n");
  },
});
