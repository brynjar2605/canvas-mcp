import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CanvasClient, type FetchImpl } from "../src/canvas/client.js";
import type { Config } from "../src/config.js";
import { tool } from "../src/tools/apply_course_mapping.js";

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

const COURSES = [
  { id: 1005, course_code: "T-603-THYD", name: "Þýðendur", term: { name: "Haustönn 2026" }, workflow_state: "available" },
];

describe("apply_course_mapping tool", () => {
  let schoolRoot: string;

  beforeEach(() => {
    schoolRoot = mkdtempSync(join(tmpdir(), "canvas-mcp-apply-"));
    mkdirSync(join(schoolRoot, "onn 5", "THYD"), { recursive: true });
  });

  afterEach(() => {
    rmSync(schoolRoot, { recursive: true, force: true });
  });

  function fakeConfig(): Config {
    return { baseUrl: "https://x.test", token: "t", schoolRoot, currentSemester: 5 };
  }

  it("refuses without confirm: true", async () => {
    const fetchImpl: FetchImpl = async () => jsonResponse(COURSES);
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });
    await expect(
      tool.handler({ semester: 5, confirm: false }, { client, config: fakeConfig() }),
    ).rejects.toThrow(/Refusing to apply/);
  });

  it("prints absolute paths for what it did", async () => {
    const fetchImpl: FetchImpl = async () => jsonResponse(COURSES);
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const result = await tool.handler({ semester: 5, confirm: true }, { client, config: fakeConfig() });

    const absDir = join(schoolRoot, "onn 5");
    expect(result).toContain(`Applied mapping for ${absDir}:`);
    expect(result).toContain(`renamed: ${join(absDir, "THYD")} -> ${join(absDir, "thyd")}`);
  });
});
