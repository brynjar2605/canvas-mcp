import { describe, expect, it } from "vitest";
import { CanvasClient, type FetchImpl } from "../src/canvas/client.js";
import type { Config } from "../src/config.js";
import { tool } from "../src/tools/list_announcements.js";

function fakeConfig(): Config {
  return { baseUrl: "https://x.test", token: "t", schoolRoot: "/tmp", currentSemester: 5 };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

const COURSES = [
  { id: 1, course_code: "T-603-THYD", name: "Þýðendur", term: { name: "Haustönn 2026" }, workflow_state: "available" },
];

describe("list_announcements tool", () => {
  it("trims a long body to 600 chars by default, and returns it in full when full: true", async () => {
    const longBody = `<p>${"x".repeat(1000)}</p>`;
    const raw = [
      { id: 1, title: "Long one", message: longBody, posted_at: "2026-09-01T00:00:00Z", context_code: "course_1", html_url: "https://x.test/1" },
    ];
    const fetchImpl: FetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/courses") return jsonResponse(COURSES);
      if (url.pathname === "/api/v1/announcements") return jsonResponse(raw);
      throw new Error(`unexpected path: ${url.pathname}`);
    };
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const trimmed = await tool.handler({ course: "thyd" }, { client, config: fakeConfig() });
    expect(trimmed).toContain("_(body trimmed");
    expect(trimmed.match(/x{600}/)).toBeTruthy();
    expect(trimmed.match(/x{1000}/)).toBeFalsy();

    const full = await tool.handler({ course: "thyd", full: true }, { client, config: fakeConfig() });
    expect(full).not.toContain("_(body trimmed");
    expect(full).toContain("x".repeat(1000));
  });
});
