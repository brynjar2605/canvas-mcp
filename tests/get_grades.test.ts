import { describe, expect, it } from "vitest";
import { CanvasClient, type FetchImpl } from "../src/canvas/client.js";
import type { Config } from "../src/config.js";
import { tool } from "../src/tools/get_grades.js";

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

describe("get_grades tool", () => {
  it("drops the dead 'canvas total' column and adds a footer when every course's total is hidden", async () => {
    const enrollments = [
      { course_id: 1, type: "StudentEnrollment", grades: { current_score: null } },
      { course_id: 2, type: "StudentEnrollment", grades: { current_score: null } },
    ];
    const assignments = [{ id: 1, name: "HW1", html_url: "https://x.test/1", points_possible: 10, submission: { score: 9 } }];
    const fetchImpl: FetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/courses") return jsonResponse(COURSES);
      if (url.pathname === "/api/v1/users/self/enrollments") return jsonResponse(enrollments);
      if (url.pathname.endsWith("/assignments")) return jsonResponse(assignments);
      throw new Error(`unexpected path: ${url.pathname}`);
    };
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const result = await tool.handler({}, { client, config: fakeConfig() });

    expect(result).not.toContain("canvas total");
    expect(result).not.toMatch(/\|\s*-\s*\|\s*$/m);
    expect(result).toContain("not a projected final grade");
  });

  it("filters to one course when `course` is given", async () => {
    const enrollments = [{ course_id: 1, type: "StudentEnrollment", grades: { current_score: 88, current_grade: "A", final_score: 88 } }];
    const fetchImpl: FetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/courses") return jsonResponse(COURSES);
      if (url.pathname === "/api/v1/users/self/enrollments") return jsonResponse(enrollments);
      throw new Error(`unexpected path: ${url.pathname}`);
    };
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const result = await tool.handler({ course: "thyd" }, { client, config: fakeConfig() });
    expect(result).toContain("thyd");
    expect(result).toContain("88");
  });
});
