import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run, usage } from "../src/cli.js";

const COURSES = [
  { id: 10495, course_code: "T-603-THYD", name: "Þýðendur", term: { name: "Haustönn 2026" }, workflow_state: "available" },
];

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

describe("cli", () => {
  let schoolRoot: string;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    schoolRoot = mkdtempSync(join(tmpdir(), "canvas-mcp-cli-"));
    process.env.CANVAS_TOKEN = "test-token";
    process.env.CANVAS_BASE_URL = "https://x.test";
    process.env.SCHOOL_ROOT = schoolRoot;
    process.env.CURRENT_SEMESTER = "5";
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === "/api/v1/courses") return jsonResponse(COURSES);
      return jsonResponse([]);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    rmSync(schoolRoot, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    delete process.env.CANVAS_TOKEN;
    delete process.env.CANVAS_BASE_URL;
    delete process.env.SCHOOL_ROOT;
    delete process.env.CURRENT_SEMESTER;
  });

  it("bare invocation and help variants all print usage", async () => {
    expect(await run([])).toBe(usage());
    expect(await run(["help"])).toBe(usage());
    expect(await run(["--help"])).toBe(usage());
    expect(await run(["-h"])).toBe(usage());
  });

  it("documents mapping and status among the commands", () => {
    expect(usage()).toContain("mapping");
    expect(usage()).toContain("status");
  });

  it("rejects an unknown command", async () => {
    await expect(run(["frobnicate"])).rejects.toThrow(/Unknown command "frobnicate"/);
  });

  it("rejects an unknown flag", async () => {
    await expect(run(["mapping", "--bogus"])).rejects.toThrow(/Unknown flag: --bogus/);
  });

  it("routes `courses` through parseArgs and supports --include-past", async () => {
    const result = await run(["courses"]);
    expect(result).toContain("thyd");

    await run(["courses", "--include-past"]);
    const calledUrls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calledUrls.some((u) => u.includes("/api/v1/courses"))).toBe(true);
  });

  it("fails clearly on a non-integer --semester instead of silently becoming NaN", async () => {
    await expect(run(["mapping", "--semester", "abc"])).rejects.toThrow(/Invalid arguments for "propose_course_mapping"/);
  });

  it("requires a sync target", async () => {
    await expect(run(["sync"])).rejects.toThrow(/Usage: canvas-mcp sync/);
  });

  it("validates the sync command's course argument through its zod schema", async () => {
    await expect(run(["sync", "thyd", "--dry-run"])).resolves.toBeTypeOf("string");
  });

  it("`tool list_courses` runs the tool by name and prints its output", async () => {
    const result = await run(["tool", "list_courses"]);
    expect(result).toContain("thyd");
  });

  it("`tool nope` fails clearly and lists available tool names", async () => {
    await expect(run(["tool", "nope"])).rejects.toThrow(/Unknown tool "nope".*list_courses/s);
  });

  it("`tool get_assignment '{}'` fails zod validation", async () => {
    await expect(run(["tool", "get_assignment", "{}"])).rejects.toThrow(/Invalid arguments for "get_assignment"/);
  });

  it("`tools` lists every registered tool name", async () => {
    const result = await run(["tools"]);
    const lines = result.split("\n");
    expect(lines).toHaveLength(15);
    expect(result).toContain("list_courses — ");
  });
});
