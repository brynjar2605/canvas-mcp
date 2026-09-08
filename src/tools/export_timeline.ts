import { z } from "zod";
import { defineTool } from "./_types.js";
import { currentCourses, resolveCourse, type CourseInfo } from "../canvas/courses.js";
import {
  buildAssignmentsByCourse,
  deadlineStatus,
  findAssignmentForItem,
  getUpcoming,
  isPastDueUnmarked,
  parseEventTitle,
  type AssignmentsByCourse,
  type UpcomingItem,
  type UpcomingItemType,
} from "../canvas/calendar.js";

const DEFAULT_DAYS = 21;
const DEFAULT_START_OFFSET_DAYS = 0;

const COURSE_DESCRIBE =
  'Course slug like "thyd", full code like "T-603-THYD", numeric Canvas id, or a distinctive word from the course name. Omit for all current-semester courses.';

/** Same deadline/event split as get_upcoming — everything with a due date the student owes work
 * for is a "Deadline" row; calendar events (lectures/labs/exams) get their own row shape. */
const DEADLINE_TYPES = new Set<UpcomingItemType>(["assignment", "quiz", "discussion"]);

function isDeadline(item: UpcomingItem): boolean {
  return DEADLINE_TYPES.has(item.type);
}

type RowType = "Deadline" | "Lecture" | "Lab" | "Exam" | "Other";
type RowStatus = "Todo" | "Submitted" | "Graded" | "Missing" | null;

interface Row {
  key: string;
  type: RowType;
  title: string;
  course: string;
  start: string;
  end: string | null;
  rooms: string[];
  points: number | null;
  status: RowStatus;
  url: string | null;
  canvas_ids: number[];
  /** Section name (e.g. "Hópur 1"), when the underlying event(s) had one. null for deadlines
   * and for events with no section suffix (lectures, unsectioned courses). */
  section: string | null;
  /** Raw Canvas submission_types for a deadline row matched to an assignment (e.g.
   * ["external_tool"] for Turnitin). Empty for events and unmatched deadlines (quiz/discussion,
   * or an assignment id the fetched list didn't contain). */
  submissionTypes: string[];
  /** True when a deadline's due date has passed but its `status` is only "Todo" — i.e. Canvas
   * hasn't itself flagged it `missing` (e.g. a Turnitin submission the planner doesn't see).
   * Always false for events. Consumers should render this distinctly from "Missing" rather
   * than treating it as one — see CLAUDE.md's rule against inferring Missing ourselves. */
  pastDue: boolean;
}

function toIsoUtc(iso: string): string {
  return new Date(iso).toISOString();
}

function absoluteUrl(baseUrl: string, url: string | null): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

function deadlineKey(item: UpcomingItem): string {
  return `${item.type}:${item.contentId}`;
}

function deadlineToRow(
  item: UpcomingItem,
  baseUrl: string,
  now: Date,
  assignmentsByCourse: AssignmentsByCourse,
): Row {
  const assignment = findAssignmentForItem(item, assignmentsByCourse);
  const status = deadlineStatus(item, assignment);
  return {
    key: deadlineKey(item),
    type: "Deadline",
    title: item.title,
    course: item.courseSlug ?? "",
    start: toIsoUtc(item.date),
    end: null,
    rooms: [],
    points: item.points,
    status,
    url: absoluteUrl(baseUrl, item.htmlUrl),
    canvas_ids: item.contentId !== null ? [item.contentId] : [],
    section: null,
    submissionTypes: assignment?.submissionTypes ?? [],
    pastDue: isPastDueUnmarked(item, status, now),
  };
}

function eventRowType(kind: string): RowType {
  if (kind === "Fyrirlestrar") return "Lecture";
  if (kind === "Dæmatímar") return "Lab";
  const lower = kind.toLowerCase();
  if (lower.includes("próf") || lower.includes("exam")) return "Exam";
  return "Other";
}

/**
 * Merges events sharing (courseSlug, start, end, kind) into one row — the same
 * (course, start, end, kind) grouping get_upcoming's `formatEvents` uses for the same
 * "several sections, one timeslot" case (e.g. two Dæmatímar rooms) — but keeps every
 * underlying event id and room instead of collapsing them into display text.
 */
function eventsToRows(
  items: UpcomingItem[],
  baseUrl: string,
  courseNameBySlug: Map<string, string>,
): Row[] {
  interface Group {
    courseSlug: string | null;
    startIso: string;
    endIso: string | null;
    kind: string;
    rooms: Set<string>;
    ids: number[];
    points: number | null;
    url: string | null;
    section: string | null;
  }
  const groups = new Map<string, Group>();
  const order: string[] = [];

  for (const item of items) {
    const startIso = toIsoUtc(item.date);
    const endIso = item.endDate ? toIsoUtc(item.endDate) : null;
    const parsed = parseEventTitle(item.title);
    const key = `event:${item.courseSlug ?? ""}:${startIso}:${parsed.kind}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        courseSlug: item.courseSlug,
        startIso,
        endIso,
        kind: parsed.kind,
        rooms: new Set(),
        ids: [],
        points: item.points,
        url: item.htmlUrl,
        section: item.section,
      };
      groups.set(key, g);
      order.push(key);
    }
    const room = parsed.room ?? item.location;
    if (room) g.rooms.add(room);
    if (item.contentId !== null) g.ids.push(item.contentId);
    if (!g.url && item.htmlUrl) g.url = item.htmlUrl;
    if (!g.section && item.section) g.section = item.section;
  }

  return order.map((key) => {
    const g = groups.get(key)!;
    const courseName = g.courseSlug ? courseNameBySlug.get(g.courseSlug) ?? null : null;
    const title = courseName ? `${g.kind} — ${courseName}` : g.kind;
    return {
      key,
      type: eventRowType(g.kind),
      title,
      course: g.courseSlug ?? "",
      start: g.startIso,
      end: g.endIso,
      rooms: [...g.rooms],
      points: g.points,
      status: null,
      url: absoluteUrl(baseUrl, g.url),
      canvas_ids: g.ids,
      section: g.section,
      submissionTypes: [],
      pastDue: false,
    };
  });
}

export const tool = defineTool({
  name: "export_timeline",
  description:
    "Structured JSON export of the Canvas timeline (deadlines, lectures, labs) for syncing into external " +
    "calendars/Notion. Each row has a stable `key` for deduplication. Use get_upcoming for a human-readable view.",
  inputSchema: {
    days: z
      .number()
      .int()
      .min(1)
      .max(120)
      .optional()
      .describe(`Look-ahead window in days from now, default ${DEFAULT_DAYS} (1-120).`),
    start_offset_days: z
      .number()
      .int()
      .optional()
      .describe("Shifts the window's start relative to now; default 0. Negative includes the past, e.g. -7."),
    course: z.union([z.string(), z.number()]).optional().describe(COURSE_DESCRIBE),
    include_events: z
      .boolean()
      .optional()
      .describe("Include lectures/labs/exams, not just deadlines. Default true."),
  },
  handler: async (input, ctx) => {
    const days = input.days ?? DEFAULT_DAYS;
    const startOffsetDays = input.start_offset_days ?? DEFAULT_START_OFFSET_DAYS;
    const includeEvents = input.include_events ?? true;

    const courses: CourseInfo[] = input.course
      ? [await resolveCourse(ctx.client, input.course)]
      : await currentCourses(ctx.client);

    const now = new Date();
    const from = new Date(now.getTime() + startOffsetDays * 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

    if (courses.length === 0) {
      return JSON.stringify({ generated_at: now.toISOString(), range: { from, to }, rows: [] }, null, 2);
    }

    const items = await getUpcoming(ctx.client, courses, days, startOffsetDays);
    const courseNameBySlug = new Map(courses.map((c) => [c.slug, c.name]));

    const deadlineItems = items.filter(isDeadline);
    const eventItems = includeEvents ? items.filter((i) => i.type === "event") : [];
    const assignmentsByCourse = await buildAssignmentsByCourse(ctx.client, courses, deadlineItems);

    const rows: Row[] = [
      ...deadlineItems.map((item) => deadlineToRow(item, ctx.config.baseUrl, now, assignmentsByCourse)),
      ...eventsToRows(eventItems, ctx.config.baseUrl, courseNameBySlug),
    ];
    rows.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

    return JSON.stringify({ generated_at: now.toISOString(), range: { from, to }, rows }, null, 2);
  },
});
