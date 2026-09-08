import { describe, expect, it } from "vitest";
import { CanvasClient, type FetchImpl } from "../src/canvas/client.js";
import type { Config } from "../src/config.js";
import { tool } from "../src/tools/list_courses.js";

function fakeConfig(): Config {
  return { baseUrl: "https://x.test", token: "t", schoolRoot: "/tmp", currentSemester: 5 };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

describe("list_courses tool", () => {
  it("includes an id column", async () => {
    const courses = [
      { id: 10495, course_code: "T-603-THYD", name: "Þýðendur", term: { name: "Haustönn 2026" }, workflow_state: "available" },
    ];
    const fetchImpl: FetchImpl = async () => jsonResponse(courses);
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const result = await tool.handler({}, { client, config: fakeConfig() });
    expect(result).toMatch(/\| id \| slug \|/);
    expect(result).toContain("10495");
  });

  it("gives an actionable empty-state message rather than a bare 'No courses found'", async () => {
    const fetchImpl: FetchImpl = async () => jsonResponse([]);
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const result = await tool.handler({}, { client, config: fakeConfig() });
    expect(result).toMatch(/announcement and video shells are filtered out/);
  });
});
