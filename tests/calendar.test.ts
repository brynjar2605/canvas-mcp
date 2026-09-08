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
});
