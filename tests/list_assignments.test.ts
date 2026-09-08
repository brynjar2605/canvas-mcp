import { describe, expect, it } from "vitest";
import { CanvasClient, type FetchImpl } from "../src/canvas/client.js";
import type { Config } from "../src/config.js";
import { tool } from "../src/tools/list_assignments.js";

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

describe("list_assignments tool", () => {
  it("shows '(graded in class)' instead of implying an online submission for on_paper/none assignments", async () => {
    const assignments = [
      {
        id: 5,
        name: "Class participation",
        due_at: "2026-09-01T00:00:00Z",
        points_possible: 2,
        html_url: "https://x.test/5",
        submission_types: ["on_paper"],
        submission: { workflow_state: "graded", score: 2, submitted_at: null },
      },
      {
        id: 6,
        name: "Online essay",
        due_at: "2026-09-02T00:00:00Z",
        points_possible: 10,
        html_url: "https://x.test/6",
        submission_types: ["online_upload"],
        submission: { workflow_state: "graded", score: 9, submitted_at: "2026-09-01T00:00:00Z" },
      },
    ];
    const fetchImpl: FetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/courses") return jsonResponse(COURSES);
      if (url.pathname === "/api/v1/courses/1/assignments") return jsonResponse(assignments);
      throw new Error(`unexpected path: ${url.pathname}`);
    };
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const result = await tool.handler({ course: "thyd", filter: "all" }, { client, config: fakeConfig() });

    expect(result).toContain("Class participation");
    expect(result).toMatch(/score 2\/2.*\(graded in class\)/);
    expect(result).toContain("Online essay");
    expect(result).not.toMatch(/Online essay.*\(graded in class\)/);
    expect(result).toMatch(/\(assignment_id 5\)/);
    expect(result).toMatch(/\(assignment_id 6\)/);
  });

  it("drops the parenthesised grade when it duplicates the score text", async () => {
    const assignments = [
      {
        id: 9,
        name: "Redundant grade",
        due_at: "2026-09-01T00:00:00Z",
        points_possible: 10,
        html_url: "https://x.test/9",
        submission: { workflow_state: "graded", score: 8, grade: "8/10" },
      },
      {
        id: 10,
        name: "Letter grade",
        due_at: "2026-09-01T00:00:00Z",
        points_possible: 10,
        html_url: "https://x.test/10",
        submission: { workflow_state: "graded", score: 9, grade: "A" },
      },
    ];
    const fetchImpl: FetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/courses") return jsonResponse(COURSES);
      if (url.pathname === "/api/v1/courses/1/assignments") return jsonResponse(assignments);
      throw new Error(`unexpected path: ${url.pathname}`);
    };
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const result = await tool.handler({ course: "thyd", filter: "all" }, { client, config: fakeConfig() });

    expect(result).toMatch(/Redundant grade — .+ — score 8\/10 \(assignment_id 9\)/);
    expect(result).not.toMatch(/score 8\/10 \(8\/10\)/);
    expect(result).toMatch(/Letter grade — .+ — score 9\/10 \(A\) \(assignment_id 10\)/);
  });
});
