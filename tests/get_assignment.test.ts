import { describe, expect, it } from "vitest";
import { CanvasClient, type FetchImpl } from "../src/canvas/client.js";
import type { Config } from "../src/config.js";
import { tool } from "../src/tools/get_assignment.js";

function fakeConfig(): Config {
  return { baseUrl: "https://x.test", token: "t", schoolRoot: "/tmp", currentSemester: 5 };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

const COURSES = [
  { id: 1, course_code: "T-603-THYD", name: "Þýðendur", term: { name: "Haustönn 2026" }, workflow_state: "available" },
];

function clientFor(assignment: unknown): CanvasClient {
  const fetchImpl: FetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/courses") return jsonResponse(COURSES);
    if (url.pathname === "/api/v1/courses/1/assignments/42") return jsonResponse(assignment);
    throw new Error(`unexpected path: ${url.pathname}`);
  };
  return new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });
}

describe("get_assignment tool", () => {
  it("reports 'graded in class' (not 'submitted') for an on_paper/none assignment with a score", async () => {
    const assignment = {
      id: 42,
      name: "In-class quiz",
      due_at: "2026-09-01T00:00:00Z",
      points_possible: 2,
      html_url: "https://x.test/42",
      submission_types: ["on_paper"],
      submission: { workflow_state: "graded", score: 2, grade: "2", submitted_at: null },
    };
    const result = await tool.handler({ course: "thyd", assignment_id: 42 }, { client: clientFor(assignment), config: fakeConfig() });

    expect(result).toContain("- Status: graded in class");
    expect(result).not.toContain("Status: submitted");
    // The redundant "(2)" grade must be dropped since it just restates the score.
    expect(result).toContain("- Score: 2/2");
    expect(result).not.toContain("2/2 (2)");
  });

  it("keeps 'submitted' status for a real online submission", async () => {
    const assignment = {
      id: 42,
      name: "Essay",
      due_at: "2026-09-01T00:00:00Z",
      points_possible: 10,
      html_url: "https://x.test/42",
      submission_types: ["online_upload"],
      submission: { workflow_state: "submitted", submitted_at: "2026-08-30T00:00:00Z" },
    };
    const result = await tool.handler({ course: "thyd", assignment_id: 42 }, { client: clientFor(assignment), config: fakeConfig() });
    expect(result).toContain("- Status: submitted");
  });

  it("keeps an informative grade (letter grade) alongside the score", async () => {
    const assignment = {
      id: 42,
      name: "Essay",
      due_at: null,
      points_possible: 10,
      html_url: "https://x.test/42",
      submission_types: ["online_upload"],
      submission: { workflow_state: "graded", score: 8, grade: "B", submitted_at: "2026-08-30T00:00:00Z" },
    };
    const result = await tool.handler({ course: "thyd", assignment_id: 42 }, { client: clientFor(assignment), config: fakeConfig() });
    expect(result).toContain("- Score: 8/10 (B)");
  });

  it("strips verifier params from the description and lists each attachment once, without repeating its url", async () => {
    const assignment = {
      id: 42,
      name: "Lab 3",
      due_at: null,
      points_possible: null,
      html_url: "https://x.test/42",
      description:
        '<p>See <a href="https://x.test/files/2712565/download?verifier=abc123&amp;wrap=1">THYD_LabExercise_03.pdf</a>.</p>',
    };
    const result = await tool.handler({ course: "thyd", assignment_id: 42 }, { client: clientFor(assignment), config: fakeConfig() });

    expect(result).not.toContain("verifier");
    // Description keeps its markdown link (verifier stripped; turndown escapes the underscores) ...
    expect(result).toContain("(https://x.test/files/2712565/download?wrap=1)");
    // ... and the Attachments section names the file + file_id without repeating the url.
    expect(result).toContain("- THYD_LabExercise_03.pdf — file_id 2712565");
    expect(result).not.toContain("(https://x.test/files/2712565/download?wrap=1) (file_id");
    const attachmentsSection = result.slice(result.indexOf("## Attachments"));
    expect(attachmentsSection.match(/2712565/g)).toHaveLength(1);
  });
});
