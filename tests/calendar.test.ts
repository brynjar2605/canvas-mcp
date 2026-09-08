import { describe, expect, it, vi } from "vitest";
import { CanvasClient, type FetchImpl } from "../src/canvas/client.js";
import {
  formatReykjavikDateTime,
  formatReykjavikDay,
  formatReykjavikTimeRange,
  getUpcoming,
  parseEventTitle,
} from "../src/canvas/calendar.js";
import type { CourseInfo } from "../src/canvas/courses.js";

const courses: CourseInfo[] = [
  { id: 1, code: "T-603-THYD", slug: "thyd", name: "Þýðendur", term: "Haustönn 2026", semester: 5 },
  { id: 2, code: "T-409-TSAM", slug: "tsam", name: "Tölvusamskipti", term: "Haustönn 2026", semester: 5 },
];

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

function fakeConfig() {
  return { baseUrl: "https://x.test", token: "t", schoolRoot: "/tmp", currentSemester: 5 };
}

describe("formatReykjavikDateTime / formatReykjavikDay", () => {
  it("renders the UTC instant directly (Atlantic/Reykjavik == UTC, no DST)", () => {
    expect(formatReykjavikDateTime("2026-09-14T23:59:00Z")).toBe("Mon 14 Sep 23:59");
    expect(formatReykjavikDay("2026-09-14T23:59:00Z")).toBe("Mon 14 Sep");
  });

  it("pads single-digit hours/minutes", () => {
    expect(formatReykjavikDateTime("2026-01-05T09:05:00Z")).toBe("Mon 5 Jan 09:05");
  });

  it("appends the year when it differs from the current calendar year", () => {
    const now = new Date("2026-09-08T00:00:00Z");
    expect(formatReykjavikDateTime("2025-09-14T23:59:00Z", now)).toBe("Sun 14 Sep 2025 23:59");
    expect(formatReykjavikDateTime("2026-09-14T23:59:00Z", now)).toBe("Mon 14 Sep 23:59");
  });
});

describe("formatReykjavikTimeRange", () => {
  it("renders start–end when an end time is known", () => {
    expect(formatReykjavikTimeRange("2026-09-14T08:30:00Z", "2026-09-14T10:10:00Z")).toBe("08:30–10:10");
  });

  it("renders just the start time when there is no end", () => {
    expect(formatReykjavikTimeRange("2026-09-14T08:30:00Z", null)).toBe("08:30");
    expect(formatReykjavikTimeRange("2026-09-14T08:30:00Z")).toBe("08:30");
  });
});

describe("parseEventTitle", () => {
  it("splits RU's <ROOM> - <course name> - <kind> convention", () => {
    expect(parseEventTitle("M120 - Tölvusamskipti - Dæmatímar")).toEqual({ room: "M120", kind: "Dæmatímar" });
    expect(parseEventTitle("V108 - Nethernaður og glæpastarfsemi - Fyrirlestrar")).toEqual({
      room: "V108",
      kind: "Fyrirlestrar",
    });
    expect(parseEventTitle("V104 - Þýðendur - Dæmatímar")).toEqual({ room: "V104", kind: "Dæmatímar" });
  });

  it("falls back to the whole title as kind, with no room, when the title doesn't match", () => {
    expect(parseEventTitle("Dæmatímar")).toEqual({ room: null, kind: "Dæmatímar" });
    expect(parseEventTitle("Fyrirlestur")).toEqual({ room: null, kind: "Fyrirlestur" });
    expect(parseEventTitle("Q&A session")).toEqual({ room: null, kind: "Q&A session" });
  });
});

describe("getUpcoming", () => {
  it("merges planner items + calendar events, dedupes (type,id), and sorts by date", async () => {
    const plannerItems = [
      {
        plannable_type: "assignment",
        plannable_id: 10,
        plannable_date: "2026-09-12T23:59:00Z",
        course_id: 1,
        plannable: { title: "HW1", points_possible: 10 },
        html_url: "https://x.test/hw1",
        submissions: { submitted: true },
      },
      {
        plannable_type: "calendar_event",
        plannable_id: 55,
        plannable_date: "2026-09-10T10:00:00Z",
        course_id: 2,
        plannable: {
          title: "Lecture 1",
          start_at: "2026-09-10T10:00:00Z",
          end_at: "2026-09-10T11:40:00Z",
          location_name: "M120",
        },
        html_url: "https://x.test/event/55",
        submissions: false,
      },
      {
        plannable_type: "quiz",
        plannable_id: 20,
        plannable_date: "2026-09-11T09:00:00Z",
        course_id: 1,
        plannable: { title: "Quiz 1", points_possible: 5 },
        html_url: "https://x.test/quiz1",
      },
    ];
    // 55 duplicates the planner's calendar_event entry -> must be deduped away.
    const calendarEvents = [
      { id: 55, title: "Lecture 1", start_at: "2026-09-10T10:00:00Z", context_code: "course_2", html_url: "https://x.test/event/55" },
      { id: 56, title: "Lab 1", start_at: "2026-09-13T14:00:00Z", context_code: "course_2", html_url: "https://x.test/event/56" },
    ];

    const fetchImpl = vi.fn<FetchImpl>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/planner/items") return jsonResponse(plannerItems);
      if (url.pathname === "/api/v1/calendar_events") return jsonResponse(calendarEvents);
      throw new Error(`unexpected path: ${url.pathname}`);
    });
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const items = await getUpcoming(client, courses, 14);

    expect(items.map((i) => i.title)).toEqual(["Lecture 1", "Quiz 1", "HW1", "Lab 1"]);
    expect(items.filter((i) => i.title === "Lecture 1")).toHaveLength(1);

    const hw1 = items.find((i) => i.title === "HW1")!;
    expect(hw1).toMatchObject({ type: "assignment", courseSlug: "thyd", courseId: 1, points: 10, submitted: true, contentId: 10 });

    const lecture = items.find((i) => i.title === "Lecture 1")!;
    expect(lecture).toMatchObject({ type: "event", courseSlug: "tsam", courseId: 2, points: null, submitted: null, contentId: 55 });
    // The planner's own copy (with end_at) wins over the calendar_events duplicate that gets deduped away.
    expect(lecture.endDate).toBe("2026-09-10T11:40:00Z");
    expect(lecture.location).toBe("M120");
  });

  it("sends start_date/end_date and context_codes[] for the given courses", async () => {
    const fetchImpl = vi.fn<FetchImpl>().mockImplementation(async () => jsonResponse([]));
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    await getUpcoming(client, courses, 7);

    const plannerCall = fetchImpl.mock.calls.find(([u]) => String(u).includes("/planner/items"));
    expect(plannerCall).toBeTruthy();
    const url = new URL(String(plannerCall![0]));
    expect(url.searchParams.get("start_date")).toBeTruthy();
    expect(url.searchParams.get("end_date")).toBeTruthy();
    expect(url.searchParams.getAll("context_codes[]")).toEqual(["course_1", "course_2"]);
  });

  it("returns [] without calling fetch when there are no courses", async () => {
    const fetchImpl = vi.fn<FetchImpl>();
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });
    expect(await getUpcoming(client, [], 14)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips a calendar_event with no start_at", async () => {
    const fetchImpl = vi.fn<FetchImpl>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/planner/items") return jsonResponse([]);
      return jsonResponse([{ id: 1, title: "TBD", start_at: null, context_code: "course_1", html_url: "https://x.test/1" }]);
    });
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });
    const items = await getUpcoming(client, courses, 14);
    expect(items).toEqual([]);
  });

  // Live data from reykjavik.instructure.com for tsam (course 2) on 2026-09-09: the planner
  // (already scoped to the caller's own section) returns exactly one Dæmatímar — the
  // "child" event 944371, whose calendar_events copy carries parent_event_id 944370 and
  // context_code course_section_13627. /calendar_events for the whole course additionally
  // returns SIX course-wide "parent" events (one per section per timeslot, each with
  // child_events_count: 1, parent_event_id: null, context_code course_10483) plus one
  // course-wide lecture (child_events_count: 0). Only the caller's own lab and the lecture
  // must survive; the five other sections' parents must not.
  it("drops course-wide parent events (child_events_count > 0) but keeps the caller's own section and course-wide lectures", async () => {
    const plannerItems = [
      {
        plannable_type: "calendar_event",
        plannable_id: 944371,
        plannable_date: "2026-09-09T08:30:00Z",
        course_id: 2,
        plannable: {
          title: "M120 - Tölvusamskipti - Dæmatímar (Hópur 1)",
          start_at: "2026-09-09T08:30:00Z",
          end_at: "2026-09-09T10:10:00Z",
          location_name: "M120",
        },
        html_url: "https://x.test/event/944371",
        submissions: false,
      },
    ];
    const calendarEvents = [
      // Parents for all six section slots (three timeslots x two other courses' worth of
      // sections in this fixture) — none of these belong to the caller and must be dropped.
      { id: 944370, title: "M120 - Tölvusamskipti - Dæmatímar", start_at: "2026-09-09T08:30:00Z", context_code: "course_10483", parent_event_id: null, child_events_count: 1, html_url: "https://x.test/event/944370" },
      { id: 944800, title: "M121 - Tölvusamskipti - Dæmatímar", start_at: "2026-09-09T08:30:00Z", context_code: "course_10483", parent_event_id: null, child_events_count: 1, html_url: "https://x.test/event/944800" },
      { id: 944392, title: "M121 - Tölvusamskipti - Dæmatímar", start_at: "2026-09-09T10:10:00Z", context_code: "course_10483", parent_event_id: null, child_events_count: 1, html_url: "https://x.test/event/944392" },
      { id: 944824, title: "M120 - Tölvusamskipti - Dæmatímar", start_at: "2026-09-09T10:10:00Z", context_code: "course_10483", parent_event_id: null, child_events_count: 1, html_url: "https://x.test/event/944824" },
      { id: 944774, title: "M121 - Tölvusamskipti - Dæmatímar", start_at: "2026-09-09T12:40:00Z", context_code: "course_10483", parent_event_id: null, child_events_count: 1, html_url: "https://x.test/event/944774" },
      { id: 949233, title: "M123 - Tölvusamskipti - Dæmatímar", start_at: "2026-09-09T16:50:00Z", context_code: "course_10483", parent_event_id: null, child_events_count: 1, html_url: "https://x.test/event/949233" },
      // Course-wide lecture (no sections) — must stay.
      { id: 934198, title: "M101 - Tölvusamskipti - Fyrirlestrar", start_at: "2026-09-09T12:40:00Z", context_code: "course_10483", parent_event_id: null, child_events_count: 0, html_url: "https://x.test/event/934198" },
      // The caller's own section's child event — also appears in calendar_events, but
      // dedupes against the planner's copy of id 944371.
      { id: 944371, title: "M120 - Tölvusamskipti - Dæmatímar (Hópur 1)", start_at: "2026-09-09T08:30:00Z", context_code: "course_section_13627", parent_event_id: 944370, child_events_count: 0, html_url: "https://x.test/event/944371" },
    ];

    const fetchImpl = vi.fn<FetchImpl>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/planner/items") return jsonResponse(plannerItems);
      if (url.pathname === "/api/v1/calendar_events") return jsonResponse(calendarEvents);
      throw new Error(`unexpected path: ${url.pathname}`);
    });
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const items = await getUpcoming(client, courses, 1, 0);
    const dayItems = items.filter((i) => i.date.startsWith("2026-09-09"));

    expect(dayItems).toHaveLength(2);

    const lab = dayItems.find((i) => i.contentId === 944371)!;
    expect(lab).toBeTruthy();
    expect(lab.title).toBe("M120 - Tölvusamskipti - Dæmatímar");
    expect(lab.section).toBe("Hópur 1");
    expect(parseEventTitle(lab.title)).toEqual({ room: "M120", kind: "Dæmatímar" });

    const lecture = dayItems.find((i) => i.contentId === 934198)!;
    expect(lecture).toBeTruthy();
    expect(lecture.section).toBeNull();

    expect(dayItems.some((i) => i.contentId === 944800)).toBe(false); // M121 08:30 — other section
    expect(dayItems.some((i) => i.contentId === 944392)).toBe(false); // M121 10:10
    expect(dayItems.some((i) => i.contentId === 944824)).toBe(false); // M120 10:10
    expect(dayItems.some((i) => i.contentId === 944774)).toBe(false); // M121 12:40
    expect(dayItems.some((i) => i.contentId === 949233)).toBe(false); // M123 16:50
  });

  it("keeps genuinely course-wide duplicate events (child_events_count: 0, no parent/child relationship)", async () => {
    // Two distinct course-wide calendar_events (not section overrides — both have
    // child_events_count: 0) that happen to share a timeslot and kind, e.g. a shared
    // multi-room lecture recorded as two separate Canvas events. Both must be kept; merging
    // them into one display line is export_timeline/get_upcoming's job, not getUpcoming's.
    const calendarEvents = [
      { id: 501, title: "V104 - Þýðendur - Fyrirlestrar", start_at: "2026-09-09T08:30:00Z", context_code: "course_1", parent_event_id: null, child_events_count: 0, html_url: "https://x.test/event/501" },
      { id: 502, title: "V105 - Þýðendur - Fyrirlestrar", start_at: "2026-09-09T08:30:00Z", context_code: "course_1", parent_event_id: null, child_events_count: 0, html_url: "https://x.test/event/502" },
    ];
    const fetchImpl = vi.fn<FetchImpl>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/planner/items") return jsonResponse([]);
      if (url.pathname === "/api/v1/calendar_events") return jsonResponse(calendarEvents);
      throw new Error(`unexpected path: ${url.pathname}`);
    });
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const items = await getUpcoming(client, courses, 14);

    expect(items.map((i) => i.contentId).sort()).toEqual([501, 502]);
    expect(items.every((i) => i.section === null)).toBe(true);
  });
});
