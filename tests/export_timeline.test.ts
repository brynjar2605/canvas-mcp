import { describe, expect, it } from "vitest";
import { CanvasClient, type FetchImpl } from "../src/canvas/client.js";
import type { Config } from "../src/config.js";
import { tool } from "../src/tools/export_timeline.js";

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

interface ExportedRow {
  key: string;
  type: string;
  title: string;
  course: string;
  start: string;
  end: string | null;
  rooms: string[];
  points: number | null;
  status: string | null;
  url: string | null;
  canvas_ids: number[];
}

interface ExportedTimeline {
  generated_at: string;
  range: { from: string; to: string };
  rows: ExportedRow[];
}

function fetchImplFor(plannerItems: unknown[], calendarEvents: unknown[] = []): FetchImpl {
  return async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/courses") return jsonResponse(COURSES);
    if (url.pathname === "/api/v1/planner/items") return jsonResponse(plannerItems);
    if (url.pathname === "/api/v1/calendar_events") return jsonResponse(calendarEvents);
    throw new Error(`unexpected path: ${url.pathname}`);
  };
}

async function run(
  plannerItems: unknown[],
  input: Record<string, unknown> = {},
  calendarEvents: unknown[] = [],
): Promise<ExportedTimeline> {
  const client = new CanvasClient(fakeConfig(), {
    fetchImpl: fetchImplFor(plannerItems, calendarEvents),
    sleep: async () => {},
  });
  const result = await tool.handler(input as never, { client, config: fakeConfig() });
  return JSON.parse(result) as ExportedTimeline;
}

describe("export_timeline tool", () => {
  it("drops other sections' parent events, keeping the caller's own single-room Dæmatímar section", async () => {
    // The planner is scoped to the caller's own section: one Dæmatímar child event, with
    // Canvas's "(Hópur N)" suffix on its title and a single room.
    const plannerItems = [
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
    // /calendar_events additionally returns the course-wide parent events for both sections
    // sharing this slot (child_events_count: 1) — both must be dropped, so only one room ends
    // up on the row.
    const calendarEvents = [
      { id: 90, title: "M120 - Þýðendur - Dæmatímar", start_at: "2026-09-14T08:30:00Z", end_at: "2026-09-14T10:10:00Z", context_code: "course_1", parent_event_id: null, child_events_count: 1, html_url: "https://x.test/event/90" },
      { id: 91, title: "M121 - Þýðendur - Dæmatímar", start_at: "2026-09-14T08:30:00Z", end_at: "2026-09-14T10:10:00Z", context_code: "course_1", parent_event_id: null, child_events_count: 1, html_url: "https://x.test/event/91" },
    ];

    const timeline = await run(plannerItems, { days: 21 }, calendarEvents);

    expect(timeline.rows).toHaveLength(1);
    const row = timeline.rows[0]!;
    expect(row.type).toBe("Lab");
    expect(row.title).toBe("Dæmatímar — Þýðendur");
    expect(row.rooms).toEqual(["M120"]);
    expect(row.canvas_ids).toEqual([60]);
    expect(row.status).toBeNull();
    expect(row.start).toBe("2026-09-14T08:30:00.000Z");
    expect(row.end).toBe("2026-09-14T10:10:00.000Z");
    expect(row.section).toBe("Hópur 1");
  });

  it("merges genuinely course-wide duplicate events (child_events_count: 0) sharing a timeslot into one row", async () => {
    // Two distinct course-wide events, not section overrides — both child_events_count: 0 —
    // that happen to share a timeslot and kind (e.g. a shared lecture split across two rooms
    // with no per-section structure). These must still merge, same as before the
    // section-parent fix, and carry no `section`.
    const calendarEvents = [
      { id: 70, title: "M120 - Þýðendur - Dæmatímar", start_at: "2026-09-14T08:30:00Z", end_at: "2026-09-14T10:10:00Z", context_code: "course_1", parent_event_id: null, child_events_count: 0, html_url: "https://x.test/event/70" },
      { id: 71, title: "M121 - Þýðendur - Dæmatímar", start_at: "2026-09-14T08:30:00Z", end_at: "2026-09-14T10:10:00Z", context_code: "course_1", parent_event_id: null, child_events_count: 0, html_url: "https://x.test/event/71" },
    ];

    const timeline = await run([], { days: 21 }, calendarEvents);

    expect(timeline.rows).toHaveLength(1);
    const row = timeline.rows[0]!;
    expect(row.type).toBe("Lab");
    expect(row.title).toBe("Dæmatímar — Þýðendur");
    expect(row.rooms).toEqual(["M120", "M121"]);
    expect(row.canvas_ids.sort()).toEqual([70, 71]);
    expect(row.section).toBeNull();
  });

  it("marks a graded assignment (score present) as Graded", async () => {
    const plannerItems = [
      {
        plannable_type: "assignment",
        plannable_id: 500,
        plannable_date: "2026-09-14T23:59:00Z",
        course_id: 1,
        plannable: { title: "Verkefni 3", points_possible: 10 },
        html_url: "/courses/1/assignments/500",
        submissions: { submitted: true, score: 9 },
      },
    ];

    const timeline = await run(plannerItems, { days: 21 });

    expect(timeline.rows).toHaveLength(1);
    const row = timeline.rows[0]!;
    expect(row.key).toBe("assignment:500");
    expect(row.type).toBe("Deadline");
    expect(row.status).toBe("Graded");
    expect(row.canvas_ids).toEqual([500]);
    expect(row.url).toBe("https://x.test/courses/1/assignments/500");
  });

  it("marks a past-due, unsubmitted assignment as Missing", async () => {
    const plannerItems = [
      {
        plannable_type: "assignment",
        plannable_id: 501,
        plannable_date: "2020-01-01T23:59:00Z",
        course_id: 1,
        plannable: { title: "Old homework", points_possible: 10 },
        submissions: { submitted: false },
      },
    ];

    const timeline = await run(plannerItems, { days: 21, start_offset_days: -3000 });

    const row = timeline.rows.find((r) => r.key === "assignment:501")!;
    expect(row.status).toBe("Missing");
  });

  it("produces stable, deterministic keys across repeated calls", async () => {
    const plannerItems = [
      {
        plannable_type: "quiz",
        plannable_id: 20,
        plannable_date: "2026-09-11T09:00:00Z",
        course_id: 1,
        plannable: { title: "Quiz 1", points_possible: 5 },
        submissions: { submitted: false },
      },
      {
        plannable_type: "calendar_event",
        plannable_id: 70,
        plannable_date: "2026-09-14T10:10:00Z",
        course_id: 2,
        plannable: {
          title: "V108 - Tölvusamskipti - Fyrirlestrar",
          start_at: "2026-09-14T10:10:00Z",
          end_at: "2026-09-14T11:50:00Z",
          location_name: "V108",
        },
      },
    ];

    const first = await run(plannerItems, { days: 21 });
    const second = await run(plannerItems, { days: 21 });

    expect(first.rows.map((r) => r.key)).toEqual(second.rows.map((r) => r.key));
    expect(first.rows.map((r) => r.key)).toContain("quiz:20");
    expect(first.rows.map((r) => r.key)).toContain(`event:tsam:2026-09-14T10:10:00.000Z:Fyrirlestrar`);
    const lecture = first.rows.find((r) => r.type === "Lecture")!;
    expect(lecture.title).toBe("Fyrirlestrar — Tölvusamskipti");
  });

  it("include_events: false yields deadlines only", async () => {
    const plannerItems = [
      {
        plannable_type: "assignment",
        plannable_id: 500,
        plannable_date: "2026-09-14T23:59:00Z",
        course_id: 1,
        plannable: { title: "Verkefni 3", points_possible: 10 },
        submissions: { submitted: false },
      },
      {
        plannable_type: "calendar_event",
        plannable_id: 60,
        plannable_date: "2026-09-14T08:30:00Z",
        course_id: 1,
        plannable: {
          title: "Dæmatímar",
          start_at: "2026-09-14T08:30:00Z",
          end_at: "2026-09-14T10:10:00Z",
          location_name: "M120",
        },
      },
    ];

    const timeline = await run(plannerItems, { days: 21, include_events: false });

    expect(timeline.rows).toHaveLength(1);
    expect(timeline.rows[0]!.type).toBe("Deadline");
  });

  it("start_offset_days: -7 includes an event from 3 days ago", async () => {
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const plannerItems = [
      {
        plannable_type: "calendar_event",
        plannable_id: 90,
        plannable_date: threeDaysAgo,
        course_id: 1,
        plannable: {
          title: "Past lecture",
          start_at: threeDaysAgo,
          end_at: threeDaysAgo,
        },
      },
    ];

    const timeline = await run(plannerItems, { days: 21, start_offset_days: -7 });

    expect(timeline.rows.some((r) => r.title.startsWith("Past lecture"))).toBe(true);
    expect(new Date(timeline.range.from).getTime()).toBeLessThan(now.getTime());
  });
});
