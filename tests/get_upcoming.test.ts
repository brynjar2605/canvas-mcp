import { describe, expect, it } from "vitest";
import { CanvasClient, type FetchImpl } from "../src/canvas/client.js";
import type { Config } from "../src/config.js";
import { tool } from "../src/tools/get_upcoming.js";

function fakeConfig(): Config {
  return { baseUrl: "https://x.test", token: "t", schoolRoot: "/tmp", currentSemester: 5 };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

const COURSES = [
  { id: 1, course_code: "T-603-THYD", name: "Þýðendur", term: { name: "Haustönn 2026" }, workflow_state: "available" },
  { id: 2, course_code: "T-409-TSAM", name: "Tölvusamskipti", term: { name: "Haustönn 2026" }, workflow_state: "available" },
];

describe("get_upcoming tool", () => {
  it("summarises deadlines vs events, lists deadlines first per day with assignment_id, and drops other sections' parent events", async () => {
    const plannerItems = [
      {
        plannable_type: "assignment",
        plannable_id: 500,
        plannable_date: "2026-09-14T23:59:00Z",
        course_id: 2,
        plannable: { title: "Verkefni 3", points_possible: 10 },
        submissions: { submitted: false },
      },
      // The caller's own section — the planner is already scoped to it.
      {
        plannable_type: "calendar_event",
        plannable_id: 60,
        plannable_date: "2026-09-14T08:30:00Z",
        course_id: 1,
        plannable: {
          title: "M120 - Þýðendur - Dæmatímar (Hópur 1)",
          start_at: "2026-09-14T08:30:00Z",
          end_at: "2026-09-14T10:10:00Z",
          location_name: "M120",
        },
      },
    ];
    // /calendar_events additionally returns the course-wide "parent" events for both this
    // slot's sections (child_events_count: 1) — neither belongs to the caller and both must
    // be dropped, leaving only the single M120 room from the planner above.
    const calendarEvents = [
      { id: 90, title: "M120 - Þýðendur - Dæmatímar", start_at: "2026-09-14T08:30:00Z", context_code: "course_1", parent_event_id: null, child_events_count: 1, html_url: "https://x.test/event/90" },
      { id: 91, title: "M121 - Þýðendur - Dæmatímar", start_at: "2026-09-14T08:30:00Z", context_code: "course_1", parent_event_id: null, child_events_count: 1, html_url: "https://x.test/event/91" },
    ];
    const fetchImpl: FetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/courses") return jsonResponse(COURSES);
      if (url.pathname === "/api/v1/planner/items") return jsonResponse(plannerItems);
      if (url.pathname === "/api/v1/calendar_events") return jsonResponse(calendarEvents);
      throw new Error(`unexpected path: ${url.pathname}`);
    };
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const result = await tool.handler({ days: 14 }, { client, config: fakeConfig() });

    expect(result).toMatch(/^1 deadline, 1 lecture\/lab in the next 14 days\.$/m);
    // Deadline appears before the event line within the day's section.
    const deadlineIdx = result.indexOf("Verkefni 3");
    const eventIdx = result.indexOf("🕘 08:30–10:10 thyd Dæmatímar");
    expect(deadlineIdx).toBeGreaterThan(-1);
    expect(eventIdx).toBeGreaterThan(-1);
    expect(deadlineIdx).toBeLessThan(eventIdx);
    expect(result).toContain("(M120)");
    expect(result).not.toContain("(M120, M121)");
    expect(result).not.toContain("M121");
    expect(result).toContain("assignment_id 500");
    expect(result).not.toContain("html_url");
    expect(result).not.toContain("https://");
  });

  it("parses RU's <ROOM> - <course name> - <kind> event titles and merges genuinely course-wide duplicate events (child_events_count: 0) by kind, not raw title", async () => {
    const plannerItems = [
      {
        plannable_type: "calendar_event",
        plannable_id: 72,
        plannable_date: "2026-09-14T10:10:00Z",
        course_id: 1,
        plannable: {
          title: "V108 - Nethernaður og glæpastarfsemi - Fyrirlestrar",
          start_at: "2026-09-14T10:10:00Z",
          end_at: "2026-09-14T11:50:00Z",
          location_name: "V108",
        },
      },
    ];
    // Two distinct course-wide events (child_events_count: 0 — no section overrides here,
    // just two rooms for the same shared lecture slot) must still merge into one display
    // line, same as before the section-parent fix.
    const calendarEvents = [
      { id: 70, title: "M120 - Tölvusamskipti - Dæmatímar", start_at: "2026-09-14T08:30:00Z", end_at: "2026-09-14T10:10:00Z", context_code: "course_2", parent_event_id: null, child_events_count: 0, html_url: "https://x.test/event/70" },
      { id: 71, title: "M121 - Tölvusamskipti - Dæmatímar", start_at: "2026-09-14T08:30:00Z", end_at: "2026-09-14T10:10:00Z", context_code: "course_2", parent_event_id: null, child_events_count: 0, html_url: "https://x.test/event/71" },
    ];
    const fetchImpl: FetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/courses") return jsonResponse(COURSES);
      if (url.pathname === "/api/v1/planner/items") return jsonResponse(plannerItems);
      if (url.pathname === "/api/v1/calendar_events") return jsonResponse(calendarEvents);
      throw new Error(`unexpected path: ${url.pathname}`);
    };
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const result = await tool.handler({ days: 14 }, { client, config: fakeConfig() });

    expect(result).toContain("🕘 08:30–10:10 tsam Dæmatímar (M120, M121)");
    expect(result).toContain("🕘 10:10–11:50 thyd Fyrirlestrar (V108)");
    // The room must not also linger inside the kind text or be duplicated.
    expect(result).not.toContain("M120 - Tölvusamskipti - Dæmatímar (M120");
    expect(result).not.toContain("M120 - Tölvusamskipti");
  });

  it("include_events: false drops the calendar noise and adjusts the summary", async () => {
    const plannerItems = [
      {
        plannable_type: "assignment",
        plannable_id: 500,
        plannable_date: "2026-09-14T23:59:00Z",
        course_id: 2,
        plannable: { title: "Verkefni 3", points_possible: 10 },
        submissions: { submitted: false },
      },
      {
        plannable_type: "calendar_event",
        plannable_id: 60,
        plannable_date: "2026-09-14T08:30:00Z",
        course_id: 1,
        plannable: { title: "Fyrirlestur", start_at: "2026-09-14T08:30:00Z", end_at: "2026-09-14T10:10:00Z" },
      },
    ];
    const fetchImpl: FetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/courses") return jsonResponse(COURSES);
      if (url.pathname === "/api/v1/planner/items") return jsonResponse(plannerItems);
      if (url.pathname === "/api/v1/calendar_events") return jsonResponse([]);
      throw new Error(`unexpected path: ${url.pathname}`);
    };
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const result = await tool.handler({ days: 14, include_events: false }, { client, config: fakeConfig() });

    expect(result).toContain("1 deadline in the next 14 days.");
    expect(result).not.toContain("Fyrirlestur");
    expect(result).toContain("Verkefni 3");
  });

  it("filters to one course when `course` is given", async () => {
    const fetchImpl: FetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/courses") return jsonResponse(COURSES);
      if (url.pathname === "/api/v1/planner/items") {
        expect(url.searchParams.getAll("context_codes[]")).toEqual(["course_1"]);
        return jsonResponse([]);
      }
      if (url.pathname === "/api/v1/calendar_events") return jsonResponse([]);
      throw new Error(`unexpected path: ${url.pathname}`);
    };
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const result = await tool.handler({ course: "thyd" }, { client, config: fakeConfig() });
    expect(result).toMatch(/No upcoming items/);
  });

  it("marks today's and tomorrow's day headers", async () => {
    const now = new Date();
    const todayIso = now.toISOString();
    const tomorrowIso = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const plannerItems = [
      {
        plannable_type: "assignment",
        plannable_id: 1,
        plannable_date: todayIso,
        course_id: 1,
        plannable: { title: "Due today", points_possible: 5 },
        submissions: { submitted: false },
      },
      {
        plannable_type: "assignment",
        plannable_id: 2,
        plannable_date: tomorrowIso,
        course_id: 1,
        plannable: { title: "Due tomorrow", points_possible: 5 },
        submissions: { submitted: false },
      },
    ];
    const fetchImpl: FetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/courses") return jsonResponse(COURSES);
      if (url.pathname === "/api/v1/planner/items") return jsonResponse(plannerItems);
      if (url.pathname === "/api/v1/calendar_events") return jsonResponse([]);
      throw new Error(`unexpected path: ${url.pathname}`);
    };
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const result = await tool.handler({ days: 5 }, { client, config: fakeConfig() });
    expect(result).toMatch(/## .+\(today\)/);
    expect(result).toMatch(/## .+\(tomorrow\)/);
  });
});
