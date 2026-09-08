import type { CanvasClient } from "./client.js";
import type { CourseInfo } from "./courses.js";
import type { CalendarEvent, PlannerItem } from "./types.js";
import { listAssignments, type AssignmentSummary } from "./assignments.js";

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
  /** Submission score, when Canvas's planner response includes one. null for events and
   * ungraded/unscored deadlines. */
  score: number | null;
  /** Canvas's own `submissions.missing` flag from the planner, when present. null for events
   * and whenever the planner didn't include it — NEVER inferred from "past due + not
   * submitted" (see `deadlineStatus`). */
  missing: boolean | null;
  /** Section name stripped from a trailing `(Hópur N)` / `(<section name>)` suffix on the
   * event's title (see `stripSectionSuffix`). null when the title carried no such suffix, or
   * for non-event item types. */
  section: string | null;
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

function scoreFromPlanner(item: PlannerItem): number | null {
  const subs = item.submissions;
  if (subs && typeof subs === "object") {
    return subs.score ?? null;
  }
  return null;
}

function missingFromPlanner(item: PlannerItem): boolean | null {
  const subs = item.submissions;
  if (subs && typeof subs === "object" && typeof subs.missing === "boolean") {
    return subs.missing;
  }
  return null;
}

const SECTION_SUFFIX_RE = /\s*\(([^()]+)\)\s*$/;

/**
 * Strips a trailing `(Hópur N)` / `(<section name>)` suffix Canvas appends to the title of a
 * per-section "child" calendar event (e.g. "M120 - Tölvusamskipti - Dæmatímar (Hópur 1)"),
 * returning the bare title plus the extracted section name — so the room-prefixed convention
 * still matches `parseEventTitle` and the section isn't just lost.
 */
function stripSectionSuffix(title: string): { title: string; section: string | null } {
  const m = SECTION_SUFFIX_RE.exec(title);
  if (!m) return { title, section: null };
  return { title: title.slice(0, m.index).trimEnd(), section: m[1]!.trim() };
}

function plannerItemToUpcoming(item: PlannerItem, byId: Map<number, CourseInfo>): UpcomingItem {
  const course = item.course_id != null ? byId.get(item.course_id) ?? null : null;
  const rawTitle = item.plannable.title ?? "(untitled)";
  const { title, section } =
    item.plannable_type === "calendar_event" ? stripSectionSuffix(rawTitle) : { title: rawTitle, section: null };
  return {
    date: item.plannable_date,
    type: plannerTypeToUpcomingType(item.plannable_type),
    title,
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
    score: scoreFromPlanner(item),
    missing: missingFromPlanner(item),
    section,
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
  const { title, section } = stripSectionSuffix(event.title);
  return {
    date: event.start_at,
    type: "event",
    title,
    courseSlug: course?.slug ?? null,
    courseId: course?.id ?? courseId,
    points: null,
    submitted: null,
    htmlUrl: event.html_url ?? null,
    endDate: event.end_at ?? null,
    contentId: event.id,
    location: event.location_name ?? null,
    score: null,
    missing: null,
    section,
  };
}

/**
 * Merged upcoming timeline for the given courses: planner items (assignments,
 * quizzes, discussions, announcements, and — confirmed live — lecture/dæmatími
 * `calendar_event` plannables too) plus the calendar_events endpoint. The
 * planner is already scoped to the caller's own section, but calendar_events
 * is not: for a course split into sections (e.g. several Dæmatímar groups),
 * Canvas gives each section its own "child" event and also a course-wide
 * "parent" event (`child_events_count > 0`, `parent_event_id: null`) that
 * stands in for *all* of them — that parent is skipped below since showing it
 * would pull in every other section's slot too; only real occurrences (plain
 * course-wide events and per-section children) are kept. Deduped by (type,
 * id): a `calendar_event` planner item's `plannable_id` is the same numeric id
 * as the underlying CalendarEvent, so both sides key as `event:<id>` and the
 * planner's copy (kept first) wins — which is why `plannerItemToUpcoming`
 * also reads `plannable.end_at`, so the lecture's end time isn't lost when
 * the calendar_events duplicate gets deduped away. Sorted by date ascending.
 *
 * `startOffsetDays` shifts the window's start relative to now (default 0 —
 * identical to the original "from now" behaviour); a negative value reaches
 * into the past, e.g. -7 to also pick up anything from the last week. The
 * window's end is always `now + days`, unaffected by the offset.
 */
export async function getUpcoming(
  client: CanvasClient,
  courses: CourseInfo[],
  days: number = DEFAULT_UPCOMING_DAYS,
  startOffsetDays: number = 0,
): Promise<UpcomingItem[]> {
  if (courses.length === 0) return [];

  const byId = courseLookup(courses);
  const now = new Date();
  const startDate = new Date(now.getTime() + startOffsetDays * 24 * 60 * 60 * 1000).toISOString();
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
      // A course-wide event with child_events_count > 0 is a "parent": Canvas has already
      // split it into per-section child events (one of which is the caller's own section,
      // if any — surfaced separately, either here with parent_event_id set or via the
      // planner). The parent itself isn't a real occurrence anyone attends, and showing it
      // would wrongly include every other section's slot too, so it's dropped here.
      if ((event.child_events_count ?? 0) > 0) continue;
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

export type DeadlineStatus = "Todo" | "Submitted" | "Graded" | "Missing";

/** Per-course map of assignment id -> summary, built by `buildAssignmentsByCourse` and
 * consulted by `deadlineStatus` for accurate submission state. */
export type AssignmentsByCourse = Map<number, Map<number, AssignmentSummary>>;

/**
 * Fetches each course's assignment list (via `listAssignments`, cached by the client's own
 * TTL) needed to resolve accurate status for the given deadline items — only courses that
 * actually have an "assignment"-type item among `items` are fetched, and each course is
 * fetched at most once regardless of how many assignment items it has.
 */
export async function buildAssignmentsByCourse(
  client: CanvasClient,
  courses: CourseInfo[],
  items: UpcomingItem[],
): Promise<AssignmentsByCourse> {
  const neededCourseIds = new Set<number>();
  for (const item of items) {
    if (item.type === "assignment" && item.courseId !== null) neededCourseIds.add(item.courseId);
  }
  const courseById = new Map(courses.map((c) => [c.id, c]));
  const result: AssignmentsByCourse = new Map();
  for (const courseId of neededCourseIds) {
    const course = courseById.get(courseId);
    if (!course) continue;
    const assignments = await listAssignments(client, course, "all");
    result.set(courseId, new Map(assignments.map((a) => [a.id, a])));
  }
  return result;
}

/** Looks up the Canvas assignment backing an "assignment"-type planner item, if any (quiz/
 * discussion items, and events, never match). */
export function findAssignmentForItem(
  item: UpcomingItem,
  assignmentsByCourse: AssignmentsByCourse,
): AssignmentSummary | null {
  if (item.type !== "assignment" || item.contentId === null || item.courseId === null) return null;
  return assignmentsByCourse.get(item.courseId)?.get(item.contentId) ?? null;
}

/**
 * Deadline status for a planner item. Prefers the matched Canvas assignment's own submission
 * state (fetched via the Assignments API with `include[]=submission`) over the planner's
 * `submissions` summary — confirmed live: Canvas's planner never sets `submitted` for
 * `external_tool` (Turnitin) assignments, even once the student has handed work in via
 * Turnitin (`workflow_state: "pending_review"`, which `isSubmitted` in assignments.ts already
 * treats as submitted). Falls back to the planner-only fields when there's no matching
 * assignment — a quiz/discussion item, or an assignment id the fetched list didn't contain.
 *
 * `missing` is NEVER inferred from "past due and not submitted" — only from Canvas's own
 * `missing` flag (the assignment's `submission.missing`, or the planner's
 * `submissions.missing`). See CLAUDE.md / the rule against asserting Missing on our own
 * heuristic instead of Canvas's.
 */
export function deadlineStatus(item: UpcomingItem, assignment: AssignmentSummary | null): DeadlineStatus {
  if (assignment) {
    if (assignment.score !== null) return "Graded";
    if (assignment.submitted) return "Submitted";
    if (assignment.missing || item.missing === true) return "Missing";
    return "Todo";
  }
  if (item.score !== null) return "Graded";
  if (item.submitted === true) return "Submitted";
  if (item.missing === true) return "Missing";
  return "Todo";
}

/**
 * True when a deadline is overdue but its status is only "Todo" — i.e. Canvas hasn't flagged
 * it `missing` (e.g. a Turnitin submission the planner doesn't see as submitted, or genuinely
 * unaddressed work Canvas simply hasn't marked yet). Callers should surface this distinctly
 * ("past due, not marked submitted in Canvas") rather than asserting a status Canvas itself
 * doesn't assert.
 */
export function isPastDueUnmarked(item: UpcomingItem, status: DeadlineStatus, now: Date): boolean {
  return status === "Todo" && new Date(item.date) < now;
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

export interface ParsedEventTitle {
  /** e.g. "M120". null when the title doesn't follow the room-prefixed convention. */
  room: string | null;
  /** e.g. "Dæmatímar" / "Fyrirlestrar" — or the whole original title, when it didn't match. */
  kind: string;
}

/** Room codes seen live: one to three letters followed by 2-4 digits ("M120", "V104", "V206"). */
const EVENT_TITLE_RE = /^([A-Z]{1,3}\d{2,4})\s*-\s*(.+?)\s*-\s*(.+)$/;

/**
 * Parses RU's calendar event title convention, `<ROOM> - <course name> - <kind>`
 * (e.g. "M120 - Tölvusamskipti - Dæmatímar"), into the room and the kind of
 * session (lecture/lab/etc). The course name in the middle is discarded —
 * callers already have it via the event's `courseSlug`. Falls back to
 * `{ room: null, kind: title }` for titles that don't follow the convention
 * (plain "Dæmatímar", "Fyrirlestur", or anything else Canvas hands back).
 */
export function parseEventTitle(title: string): ParsedEventTitle {
  const trimmed = title.trim();
  const m = EVENT_TITLE_RE.exec(trimmed);
  if (m) {
    return { room: m[1]!.trim(), kind: m[3]!.trim() };
  }
  return { room: null, kind: trimmed };
}
