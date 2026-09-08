import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CanvasClient, type FetchImpl } from "../src/canvas/client.js";
import type { Config } from "../src/config.js";
import { tool } from "../src/tools/propose_course_mapping.js";

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

const COURSES = [
  { id: 10495, course_code: "T-603-THYD", name: "Þýðendur", term: { name: "Haustönn 2026" }, workflow_state: "available" },
];

describe("propose_course_mapping tool", () => {
  let schoolRoot: string;

  beforeEach(() => {
    schoolRoot = mkdtempSync(join(tmpdir(), "canvas-mcp-propose-"));
  });

  afterEach(() => {
    rmSync(schoolRoot, { recursive: true, force: true });
  });

  function fakeConfig(): Config {
    return { baseUrl: "https://x.test", token: "t", schoolRoot, currentSemester: 5 };
  }

  it("prints the absolute semester directory and a markdown table, and flags a missing semester dir", async () => {
    const fetchImpl: FetchImpl = async () => jsonResponse(COURSES);
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const result = await tool.handler({ semester: 5 }, { client, config: fakeConfig() });

    const absDir = join(schoolRoot, "onn 5");
    expect(result).toContain(`Mapping proposal for ${absDir}`);
    expect(result).toContain(`Note: ${absDir} does not exist yet`);
    expect(result).toContain("| slug | code | name | plan |");
    expect(result).toContain("create `thyd/`");
    expect(result).toContain("Nothing has been changed.");
  });

  it("flags a case-only rename and does not claim the dir is missing when it already exists", async () => {
    mkdirSync(join(schoolRoot, "onn 5", "THYD"), { recursive: true });
    const fetchImpl: FetchImpl = async () => jsonResponse(COURSES);
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const result = await tool.handler({ semester: 5 }, { client, config: fakeConfig() });

    expect(result).not.toContain("does not exist yet");
    expect(result).toMatch(/rename `THYD\/` → `thyd\/` \(case-only/);
  });

  it("names an unmatched folder and suggests a ready-to-run override", async () => {
    mkdirSync(join(schoolRoot, "onn 5", "compilers"), { recursive: true });
    const fetchImpl: FetchImpl = async () => jsonResponse(COURSES);
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const result = await tool.handler({ semester: 5 }, { client, config: fakeConfig() });

    expect(result).toContain("Folders no course claimed (will be left untouched): `compilers`");
    expect(result).toContain('propose_course_mapping({ overrides: { "compilers": "<slug>" } })');
  });
});
