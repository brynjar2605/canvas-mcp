import { z } from "zod";
import { defineTool } from "./_types.js";
import { currentCourses, resolveCourse } from "../canvas/courses.js";
import { DEFAULT_ANNOUNCEMENT_DAYS, listAnnouncements } from "../canvas/announcements.js";
import { formatReykjavikDateTime } from "../canvas/calendar.js";

const BODY_LIMIT = 600;

export const tool = defineTool({
  name: "list_announcements",
  description:
    "List course announcements from the last N days (default 30), newest first. Bodies are trimmed to " +
    `${BODY_LIMIT} chars by default — pass full: true for the untrimmed body.`,
  inputSchema: {
    course: z
      .union([z.string(), z.number()])
      .optional()
      .describe(
        'Course slug like "thyd", full code like "T-603-THYD", numeric Canvas id, or a distinctive word from the course name. Omit for all current-semester courses.',
      ),
    days: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`How many days back to look (default ${DEFAULT_ANNOUNCEMENT_DAYS}).`),
    full: z
      .boolean()
      .optional()
      .describe(`Return full, untrimmed announcement bodies. Default false (bodies over ${BODY_LIMIT} chars are trimmed).`),
  },
  handler: async (input, ctx) => {
    const courses = input.course
      ? [await resolveCourse(ctx.client, input.course)]
      : await currentCourses(ctx.client);
    if (courses.length === 0) {
      return "No current courses found.";
    }

    const days = input.days ?? DEFAULT_ANNOUNCEMENT_DAYS;
    const full = input.full ?? false;
    const announcements = await listAnnouncements(ctx.client, courses, days);
    if (announcements.length === 0) {
      return `No announcements in the last ${days} days.`;
    }

    const blocks = announcements.map((a) => {
      const date = a.postedAt ? formatReykjavikDateTime(a.postedAt) : "no date";
      let body = a.bodyMarkdown.trim();
      let trimmedNote = "";
      if (!full && body.length > BODY_LIMIT) {
        body = `${body.slice(0, BODY_LIMIT)}...`;
        trimmedNote = "\n\n_(body trimmed — pass full: true for the rest)_";
      }
      return `## [${a.courseSlug}] ${a.title} — ${date}\n\n${body || "(no body)"}${trimmedNote}`;
    });
    return blocks.join("\n\n---\n\n");
  },
});
