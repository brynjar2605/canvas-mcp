import { describe, expect, it } from "vitest";
import { CanvasClient, type FetchImpl } from "../src/canvas/client.js";
import type { Config } from "../src/config.js";
import { tool } from "../src/tools/search_materials.js";

function fakeConfig(): Config {
  return { baseUrl: "https://x.test", token: "t", schoolRoot: "/tmp", currentSemester: 5 };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

const COURSES = [
  {
    id: 1,
    course_code: "T-603-THYD",
    name: "Þýðendur",
    term: { name: "Haustönn 2026" },
    workflow_state: "available",
  },
];

describe("search_materials tool", () => {
  it("appends a note when a course's Files tab is hidden and results come from discovery", async () => {
    const fetchImpl: FetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/courses") return jsonResponse(COURSES);
      if (url.pathname === "/api/v1/courses/1/files") return new Response("forbidden", { status: 403 });
      if (url.pathname === "/api/v1/courses/1/folders") return jsonResponse([]);
      if (url.pathname === "/api/v1/courses/1/modules") return jsonResponse([]);
      if (url.pathname === "/api/v1/courses/1/pages") return jsonResponse([]);
      if (url.pathname === "/api/v1/courses/1/assignments") return jsonResponse([]);
      throw new Error(`unexpected path: ${url.pathname}`);
    };
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const result = await tool.handler(
      { query: "syllabus", course: "thyd" },
      { client, config: fakeConfig() },
    );

    expect(result).toContain("No materials match");
    expect(result).toMatch(/thyd hides the Files tab/);
  });
});
