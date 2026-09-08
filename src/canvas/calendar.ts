import type { CanvasClient } from "./client.js";
import type { CourseInfo } from "./courses.js";
import type { CalendarEvent, PlannerItem } from "./types.js";

export type UpcomingItemType = "assignment" | "quiz" | "event" | "announcement" | "discussion" | "other";

export interface UpcomingItem {
  /** ISO datetime. */
  date: string;
  type: UpcomingItemType;
  title: string;
  courseSlug: string | null;
  courseId: number | null;
  points: number | null;
  submitted: boolean | null;
  htmlUrl: string | null;
  /** ISO datetime, e.g. for lectures/labs with a known end time. null/absent when Canvas gave none. */
  endDate?: string | null;
  /** Canvas id of the underlying assignment/quiz/discussion/event (`plannable_id` / event id).
   * null only when Canvas gave no id at all. */
  contentId: number | null;
  /** Room/location for a calendar event, when Canvas has one on file. */
  location: string | null;
}

export const DEFAULT_UPCOMING_DAYS = 14;

const CONTEXT_CODES_CHUNK_SIZE = 10;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function courseLookup(courses: CourseInfo[]): Map<number, CourseInfo> {
  return new Map(courses.map((c) => [c.id, c]));
}

function plannerTypeToUpcomingType(plannableType: string): UpcomingItemType {
  switch (plannableType) {
    case "assignment":
      return "assignment";
    case "quiz":
      return "quiz";
    case "discussion_topic":
      return "discussion";
    case "announcement":
      return "announcement";
    case "calendar_event":
      return "event";
    default:
      return "other";
  }
}

function submittedFromPlanner(item: PlannerItem): boolean | null {
  const subs = item.submissions;
  if (subs && typeof subs === "object") {
    return Boolean(subs.submitted);
  }
  return null;
}

function plannerItemToUpcoming(item: PlannerItem, byId: Map<number, CourseInfo>): UpcomingItem {
  const course = item.course_id != null ? byId.get(item.course_id) ?? null : null;
  return {
    date: item.plannable_date,
    type: plannerTypeToUpcomingType(item.plannable_type),
    title: item.plannable.title ?? "(untitled)",
    courseSlug: course?.slug ?? null,
    courseId: course?.id ?? item.course_id ?? null,
    points: item.plannable.points_possible ?? null,
    submitted: submittedFromPlanner(item),
    htmlUrl: item.html_url ?? null,
    // Present when plannable_type is "calendar_event" — Canvas nests the full
    // event (including end_at) under `plannable` for those planner items.
    endDate: item.plannable.end_at ?? null,
    contentId: item.plannable_id,
    location: item.plannable.location_name ?? null,
  };
}

function courseIdFromContextCode(contextCode: string): number | null {
  const m = /^course_(\d+)$/.exec(contextCode);
  return m ? Number(m[1]) : null;
}

function calendarEventToUpcoming(event: CalendarEvent, byId: Map<number, CourseInfo>): UpcomingItem | null {
  if (!event.start_at) return null;
  const courseId = courseIdFromContextCode(event.context_code);
  const course = courseId !== null ? byId.get(courseId) ?? null : null;
  return {
    date: event.start_at,
    type: "event",
    title: event.title,
    courseSlug: course?.slug ?? null,
    courseId: course?.id ?? courseId,
    points: null,
    submitted: null,
    htmlUrl: event.html_url ?? null,
    endDate: event.end_at ?? null,
    contentId: event.id,
    location: event.location_name ?? null,
  };
}

/**
 * Merged upcoming timeline for the given courses: planner items (assignments,
 * quizzes, discussions, announcements, and — confirmed live — lecture/dæmatími
 * `calendar_event` plannables too) plus the calendar_events endpoint (a
 * redundant source now that the planner covers events). Deduped by (type, id):
 * a `calendar_event` planner item's `plannable_id` is the same numeric id as
 * the underlying CalendarEvent, so both sides key as `event:<id>` and the
 * planner's copy (kept first) wins — which is why `plannerItemToUpcoming`
 * also reads `plannable.end_at`, so the lecture's end time isn't lost when
 * the calendar_events duplicate gets deduped away. Sorted by date ascending.
 */
export async function getUpcoming(
  client: CanvasClient,
  courses: CourseInfo[],
  days: number = DEFAULT_UPCOMING_DAYS,
): Promise<UpcomingItem[]> {
  if (courses.length === 0) return [];

  const byId = courseLookup(courses);
  const now = new Date();
  const startDate = now.toISOString();
  const endDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

  const seen = new Set<string>();
  const items: UpcomingItem[] = [];

  for (const group of chunk(courses, CONTEXT_CODES_CHUNK_SIZE)) {
    const contextCodes = group.map((c) => `course_${c.id}`);

    const plannerItems = await client.getAll<PlannerItem>("/api/v1/planner/items", {
      start_date: startDate,
      end_date: endDate,
      context_codes: contextCodes,
    });
    for (const item of plannerItems) {
      const key = `${plannerTypeToUpcomingType(item.plannable_type)}:${item.plannable_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(plannerItemToUpcoming(item, byId));
    }

    const calendarEvents = await client.getAll<CalendarEvent>("/api/v1/calendar_events", {
      type: "event",
      start_date: startDate,
      end_date: endDate,
      context_codes: contextCodes,
    });
    for (const event of calendarEvents) {
      const key = `event:${event.id}`;
      if (seen.has(key)) continue;
      const upcoming = calendarEventToUpcoming(event, byId);
      if (!upcoming) continue;
      seen.add(key);
      items.push(upcoming);
    }
  }

  return items.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * Formats an ISO datetime for display in Atlantic/Reykjavik (UTC, no DST —
 * so this is a plain UTC render, no timezone conversion needed): "Mon 14 Sep
 * 23:59", or "Mon 14 Sep 2025 23:59" when the date isn't in the current
 * calendar year (e.g. an `include_past` course from a previous year) — the
 * bare form would otherwise look undated for those.
 */
export function formatReykjavikDateTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const yearPart = d.getUTCFullYear() !== now.getUTCFullYear() ? ` ${d.getUTCFullYear()}` : "";
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${yearPart} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** Formats an ISO datetime's date-only part for day-grouping headers: "Mon 14 Sep". */
export function formatReykjavikDay(iso: string): string {
  const d = new Date(iso);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function timeOnly(iso: string): string {
  const d = new Date(iso);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/**
 * Formats a start (and, when known, end) time as "08:30" or "08:30–10:10" —
 * used so lectures/dæmatímar render their full time range, e.g.
 * "V104 - Þýðendur - Fyrirlestrar 08:30–10:10".
 */
export function formatReykjavikTimeRange(startIso: string, endIso?: string | null): string {
  const start = timeOnly(startIso);
  if (!endIso) return start;
  return `${start}–${timeOnly(endIso)}`;
}
