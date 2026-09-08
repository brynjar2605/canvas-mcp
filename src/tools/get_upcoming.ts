import { z } from "zod";
import { defineTool } from "./_types.js";
import { currentCourses, resolveCourse } from "../canvas/courses.js";
import {
  DEFAULT_UPCOMING_DAYS,
  formatReykjavikDay,
  formatReykjavikTimeRange,
  getUpcoming,
  parseEventTitle,
  type UpcomingItem,
  type UpcomingItemType,
} from "../canvas/calendar.js";

const COURSE_DESCRIBE =
  'Course slug like "thyd", full code like "T-603-THYD", numeric Canvas id, or a distinctive word from the course name. Omit for all current-semester courses.';

/** Deadlines: things with a due date the student owes work for. Everything else
 * (events, and the rarer announcement/other planner items) renders separately. */
const DEADLINE_TYPES = new Set<UpcomingItemType>(["assignment", "quiz", "discussion"]);

function isDeadline(item: UpcomingItem): boolean {
  return DEADLINE_TYPES.has(item.type);
}

function formatDeadline(item: UpcomingItem): string {
  const course = item.courseSlug ? `[${item.courseSlug}] ` : "";
  const points = item.points !== null ? ` — ${item.points} pts` : "";
  let status = "";
  if (item.submitted === true) status = " — submitted ✓";
  else if (item.submitted === false) status = " — not submitted";
  const idPart =
    item.contentId !== null && (item.type === "assignment" || item.type === "quiz")
      ? ` — assignment_id ${item.contentId}`
      : "";
  const time = formatReykjavikTimeRange(item.date, item.endDate);
  return `- ${time} ${course}${item.type}: ${item.title}${points}${status}${idPart}`;
}

function formatOther(item: UpcomingItem): string {
  const course = item.courseSlug ? `[${item.courseSlug}] ` : "";
  const time = formatReykjavikTimeRange(item.date, item.endDate);
  return `- ${time} ${course}${item.type}: ${item.title}`;
}

/**
 * Collapses events that share (courseSlug, start, end, kind) — e.g. the same
 * "Dæmatímar" slot taught to several sections at the same time — into one
 * compact line listing all their rooms, dropping the html_url entirely.
 * Title parsing (via `parseEventTitle`) strips RU's `<ROOM> - <course name> -
 * <kind>` convention down to just the kind, so "M120 - Tölvusamskipti -
 * Dæmatímar" and "M121 - Tölvusamskipti - Dæmatímar" at the same time merge
 * into "Dæmatímar (M120, M121)" instead of listing each section separately
 * with its room repeated in both the title and the trailing parenthesis.
 */
function formatEvents(items: UpcomingItem[]): string[] {
  interface Group {
    time: string;
    courseSlug: string | null;
    kind: string;
    rooms: Set<string>;
  }
  const groups = new Map<string, Group>();
  const order: string[] = [];

  for (const item of items) {
    const time = formatReykjavikTimeRange(item.date, item.endDate);
    const parsed = parseEventTitle(item.title);
    const room = parsed.room ?? item.location;
    const key = `${item.courseSlug ?? ""}|${time}|${parsed.kind}`;
    let g = groups.get(key);
    if (!g) {
      g = { time, courseSlug: item.courseSlug, kind: parsed.kind, rooms: new Set() };
      groups.set(key, g);
      order.push(key);
    }
    if (room) g.rooms.add(room);
  }

  return order.map((key) => {
    const g = groups.get(key)!;
    const course = g.courseSlug ? `${g.courseSlug} ` : "";
    const rooms = g.rooms.size > 0 ? ` (${[...g.rooms].join(", ")})` : "";
    return `🕘 ${g.time} ${course}${g.kind}${rooms}`;
  });
}

const MAX_ITEMS = 60;

export const tool = defineTool({
  name: "get_upcoming",
  description:
    "Timeline of everything scheduled in the next N days, across all current courses by default (or one " +
    "course via `course`): assignment/quiz/discussion deadlines first each day (with points, submitted state, " +
    "and the assignment_id needed by get_assignment), then a compact line per lecture/dæmatími from the Canvas " +
    "calendar. Use this for 'what's on this week / today / tomorrow'. For full assignment descriptions, scores, " +
    "or one course's assignment list without the calendar noise, use list_assignments instead.",
  inputSchema: {
    days: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`Look-ahead window in days (default ${DEFAULT_UPCOMING_DAYS}).`),
    course: z.union([z.string(), z.number()]).optional().describe(COURSE_DESCRIBE),
    include_events: z
      .boolean()
      .optional()
      .describe("Include lectures/labs/calendar events, not just deadlines. Default true."),
  },
  handler: async (input, ctx) => {
    const days = input.days ?? DEFAULT_UPCOMING_DAYS;
    const includeEvents = input.include_events ?? true;
    const courses = input.course
      ? [await resolveCourse(ctx.client, input.course)]
      : await currentCourses(ctx.client);
    if (courses.length === 0) {
      return "No current courses found.";
    }

    let items = await getUpcoming(ctx.client, courses, days);
    if (!includeEvents) items = items.filter((i) => i.type !== "event");
    if (items.length === 0) {
      return `No upcoming items in the next ${days} days.`;
    }

    const deadlineCount = items.filter(isDeadline).length;
    const eventCount = items.filter((i) => i.type === "event").length;
    const summaryParts = [`${deadlineCount} deadline${deadlineCount === 1 ? "" : "s"}`];
    if (includeEvents) {
      summaryParts.push(`${eventCount} lecture${eventCount === 1 ? "" : "s"}/lab${eventCount === 1 ? "" : "s"}`);
    }
    const summary = `${summaryParts.join(", ")} in the next ${days} days.`;

    const capped = items.length > MAX_ITEMS;
    const displayItems = capped ? items.slice(0, MAX_ITEMS) : items;

    const now = new Date();
    const today = formatReykjavikDay(now.toISOString());
    const tomorrow = formatReykjavikDay(new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString());

    const dayOrder: string[] = [];
    const groups = new Map<string, UpcomingItem[]>();
    for (const item of displayItems) {
      const day = formatReykjavikDay(item.date);
      let bucket = groups.get(day);
      if (!bucket) {
        bucket = [];
        groups.set(day, bucket);
        dayOrder.push(day);
      }
      bucket.push(item);
    }

    const sections: string[] = [summary];
    for (const day of dayOrder) {
      const dayItems = groups.get(day)!;
      const deadlineLines = dayItems.filter(isDeadline).map(formatDeadline);
      const eventItems = dayItems.filter((i) => i.type === "event");
      const otherLines = dayItems.filter((i) => !isDeadline(i) && i.type !== "event").map(formatOther);
      const eventLines = includeEvents ? formatEvents(eventItems) : [];

      const label = day === today ? `${day} (today)` : day === tomorrow ? `${day} (tomorrow)` : day;
      const lines = [...deadlineLines, ...otherLines, ...eventLines];
      sections.push([`## ${label}`, ...lines].join("\n"));
    }

    if (capped) {
      sections.push(
        `... and ${items.length - MAX_ITEMS} more item(s) in this window — narrow with \`days\`, \`course\`, or \`include_events: false\`.`,
      );
    }

    return sections.join("\n\n");
  },
});
