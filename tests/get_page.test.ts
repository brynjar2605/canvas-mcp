import { describe, expect, it } from "vitest";
import { CanvasClient, type FetchImpl } from "../src/canvas/client.js";
import type { Config } from "../src/config.js";
import { tool } from "../src/tools/get_page.js";

function fakeConfig(): Config {
  return { baseUrl: "https://x.test", token: "t", schoolRoot: "/tmp", currentSemester: 5 };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

const COURSES = [
  { id: 1, course_code: "T-603-THYD", name: "Þýðendur", term: { name: "Haustönn 2026" }, workflow_state: "available" },
];

describe("get_page tool", () => {
  it("names the course by slug (not numeric id) in the not-found error", async () => {
    const fetchImpl: FetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/courses") return jsonResponse(COURSES);
      if (url.pathname === "/api/v1/courses/1/pages/syllabus") return new Response("not found", { status: 404 });
      throw new Error(`unexpected path: ${url.pathname}`);
    };
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    await expect(tool.handler({ course: "thyd", page_url: "syllabus" }, { client, config: fakeConfig() })).rejects.toThrow(
      /not found in thyd\./,
    );
  });

  it("renders the updated timestamp with formatReykjavikDateTime, not a raw ISO string", async () => {
    const raw = { url: "week-1", title: "Week 1", body: "<p>Hi</p>", updated_at: "2026-08-21T13:04:11Z" };
    const fetchImpl: FetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/courses") return jsonResponse(COURSES);
      if (url.pathname === "/api/v1/courses/1/pages/week-1") return jsonResponse(raw);
      throw new Error(`unexpected path: ${url.pathname}`);
    };
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const result = await tool.handler({ course: "thyd", page_url: "week-1" }, { client, config: fakeConfig() });
    expect(result).not.toContain("2026-08-21T13:04:11Z");
    expect(result).toContain("Fri 21 Aug 13:04");
  });
});
