import { describe, expect, it } from "vitest";
import { CanvasClient, type FetchImpl } from "../src/canvas/client.js";
import type { Config } from "../src/config.js";
import { tool } from "../src/tools/list_modules.js";

function fakeConfig(): Config {
  return { baseUrl: "https://x.test", token: "t", schoolRoot: "/tmp", currentSemester: 5 };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

const COURSES = [
  { id: 1, course_code: "T-603-THYD", name: "Þýðendur", term: { name: "Haustönn 2026" }, workflow_state: "available" },
];

describe("list_modules tool", () => {
  it("prints ids using the exact parameter name the matching tool expects", async () => {
    const modules = [
      {
        id: 10,
        name: "Week 1",
        position: 1,
        items: [
          { id: 100, title: "Slides.pdf", type: "File", content_id: 456 },
          { id: 101, title: "Essay", type: "Assignment", content_id: 789 },
          { id: 102, title: "Intro", type: "Page", page_url: "intro-to-parsing" },
        ],
      },
    ];
    const fetchImpl: FetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/courses") return jsonResponse(COURSES);
      if (url.pathname === "/api/v1/courses/1/modules") return jsonResponse(modules);
      throw new Error(`unexpected path: ${url.pathname}`);
    };
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const result = await tool.handler({ course: "thyd" }, { client, config: fakeConfig() });

    expect(result).toContain("(file file_id=456)");
    expect(result).toContain("(assignment assignment_id=789)");
    expect(result).toContain("(page page_url=intro-to-parsing)");
  });
});
