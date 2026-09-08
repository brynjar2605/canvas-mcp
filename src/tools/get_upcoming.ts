import { z } from "zod";
import { defineTool } from "./_types.js";
import { currentCourses } from "../canvas/courses.js";
import {
  DEFAULT_UPCOMING_DAYS,
  formatReykjavikDay,
  formatReykjavikTimeRange,
  getUpcoming,
  type UpcomingItem,
} from "../canvas/calendar.js";

function formatItem(item: UpcomingItem): string {
  const course = item.courseSlug ? `[${item.courseSlug}] ` : "";
  const points = item.points !== null ? ` — ${item.points} pts` : "";
  let status = "";
  if (item.submitted === true) status = " — submitted ✓";
  else if (item.submitted === false) status = " — not submitted";
  const link = item.htmlUrl ? ` (${item.htmlUrl})` : "";
  const time = formatReykjavikTimeRange(item.date, item.endDate);
  return `- ${time} ${course}${item.type}: ${item.title}${points}${status}${link}`;
}

export const tool = defineTool({
  name: "get_upcoming",
  description:
    "Merged upcoming timeline across current courses — assignments, quizzes, calendar events, announcements, discussions — grouped by day.",
  inputSchema: {
    days: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`Look-ahead window in days (default ${DEFAULT_UPCOMING_DAYS}).`),
  },
  handler: async (input, ctx) => {
    const days = input.days ?? DEFAULT_UPCOMING_DAYS;
    const courses = await currentCourses(ctx.client);
    if (courses.length === 0) {
      return "No current courses found.";
    }

    const items = await getUpcoming(ctx.client, courses, days);
    if (items.length === 0) {
      return `No upcoming items in the next ${days} days.`;
    }

    const groups = new Map<string, UpcomingItem[]>();
    for (const item of items) {
      const day = formatReykjavikDay(item.date);
      const bucket = groups.get(day);
      if (bucket) bucket.push(item);
      else groups.set(day, [item]);
    }

    const sections: string[] = [];
    for (const [day, dayItems] of groups) {
      sections.push([`## ${day}`, ...dayItems.map(formatItem)].join("\n"));
    }
    return sections.join("\n\n");
  },
});
