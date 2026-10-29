import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasClient, type FetchImpl } from "../src/canvas/client.js";
import type { Config } from "../src/config.js";
import { tool } from "../src/tools/list_courses.js";

function fakeConfig(): Config {
  return { baseUrl: "https://x.test", token: "t", schoolRoot: "/tmp", currentSemester: 5 };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

const H2025 = { start_at: "2025-08-01T00:00:00Z", end_at: "2026-01-15T00:00:00Z" };
const H2026 = { start_at: "2026-08-01T00:00:00Z", end_at: "2027-01-15T00:00:00Z" };
const V2027 = { start_at: "2027-01-01T00:00:00Z", end_at: "2027-06-30T00:00:00Z" };

const WITH_FUTURE = [
  { id: 1006, course_code: "T-304-CACS", name: "Stærðfræðigreining", term: { name: "Haustönn 2025", ...H2025 }, workflow_state: "available" },
  { id: 1005, course_code: "T-603-THYD", name: "Þýðendur", term: { name: "Haustönn 2026", ...H2026 }, workflow_state: "available" },
  { id: 1002, course_code: "T-409-TSAM", name: "Tölvusamskipti", term: { name: "Haustönn 2026", ...H2026 }, workflow_state: "available" },
  { id: 11, course_code: "T-999-STAR", name: "Stærðfræði", term: { name: "Vorönn 2027", ...V2027 }, workflow_state: "available" },
];

function clientFor(data: unknown): CanvasClient {
  const fetchImpl: FetchImpl = async () => jsonResponse(data);
  return new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });
}

describe("list_courses tool", () => {
  beforeEach(() => {
    process.env.FIRST_TERM = "Haustönn 2024";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("includes an id column", async () => {
    const courses = [
      { id: 1005, course_code: "T-603-THYD", name: "Þýðendur", term: { name: "Haustönn 2026" }, workflow_state: "available" },
    ];
    const result = await tool.handler({}, { client: clientFor(courses), config: fakeConfig() });
    expect(result).toMatch(/\| id \| slug \|/);
    expect(result).toContain("1005");
    expect(result).not.toContain("Upcoming");
  });

  it("gives an actionable empty-state message rather than a bare 'No courses found'", async () => {
    const result = await tool.handler({}, { client: clientFor([]), config: fakeConfig() });
    expect(result).toMatch(/announcement and video shells are filtered out/);
  });

  it("lists the ongoing semester, not a future one, and names upcoming courses in a footer", async () => {
    const result = await tool.handler({}, { client: clientFor(WITH_FUTURE), config: fakeConfig() });
    expect(result).toContain("| thyd |");
    expect(result).toContain("| tsam |");
    expect(result).not.toContain("| star |");
    expect(result).not.toContain("| cacs |");
    expect(result).toContain(
      "Upcoming (Vorönn 2027, önn 6): star — pass include_past: true to list every semester.",
    );
  });

  it("include_past lists every semester, past and upcoming, without the footer", async () => {
    const result = await tool.handler({ include_past: true }, { client: clientFor(WITH_FUTURE), config: fakeConfig() });
    for (const slug of ["cacs", "thyd", "tsam", "star"]) expect(result).toContain(`| ${slug} |`);
    expect(result).not.toContain("Upcoming");
  });

  it("switches to the new Vorönn during the January overlap", async () => {
    vi.setSystemTime(new Date("2027-01-10T12:00:00Z"));
    const result = await tool.handler({}, { client: clientFor(WITH_FUTURE), config: fakeConfig() });
    expect(result).toContain("| star |");
    expect(result).not.toContain("| thyd |");
    expect(result).not.toContain("Upcoming");
  });
});
