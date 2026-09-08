import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CanvasClient } from "../src/canvas/client.js";
import type { CourseInfo } from "../src/canvas/courses.js";
import type { CanvasFile, Folder } from "../src/canvas/types.js";
import { syncCourse } from "../src/sync/engine.js";
import { canvasDir } from "../src/config.js";

const COURSE: CourseInfo = {
  id: 1,
  code: "T-603-THYD",
  slug: "thyd",
  name: "Þýðendur",
  term: "Haustönn 2026",
  semester: 5,
};

const ROOT_FOLDER: Folder = {
  id: 1,
  name: "course files",
  full_name: "course files",
  parent_folder_id: null,
  files_count: 0,
  folders_count: 0,
};

function baseFiles(): CanvasFile[] {
  return [
    {
      id: 101,
      display_name: "a.pdf",
      filename: "a.pdf",
      folder_id: 1,
      size: 10,
      "content-type": "application/pdf",
      url: "https://cdn.test/content/101",
      updated_at: "2026-01-01T00:00:00Z",
    },
    {
      id: 102,
      display_name: "b.pdf",
      filename: "b.pdf",
      folder_id: 1,
      size: 20,
      "content-type": "application/pdf",
      url: "https://cdn.test/content/102",
      updated_at: "2026-01-01T00:00:00Z",
    },
    {
      id: 103,
      display_name: "c.pdf",
      filename: "c.pdf",
      folder_id: 1,
      size: 30,
      "content-type": "application/pdf",
      url: "https://cdn.test/content/103",
      updated_at: "2026-01-01T00:00:00Z",
    },
  ];
}

/** Builds a fresh CanvasClient backed by `state.files` (mutable across calls, no caching reuse across clients). */
function makeClient(state: { files: CanvasFile[] }): CanvasClient {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const path = url.pathname;

    if (path === "/api/v1/courses/1/folders") return jsonResponse([ROOT_FOLDER]);
    if (path === "/api/v1/courses/1/files") return jsonResponse(state.files);
    if (path === "/api/v1/courses/1/modules") return jsonResponse([]);
    if (path === "/api/v1/courses/1/pages") return jsonResponse([]);

    const fileMatch = path.match(/^\/api\/v1\/files\/(\d+)$/);
    if (fileMatch) {
      const f = state.files.find((x) => x.id === Number(fileMatch[1]));
      if (!f) return new Response("not found", { status: 404 });
      return jsonResponse(f);
    }

    const contentMatch = path.match(/^\/content\/(\d+)$/);
    if (contentMatch) {
      return new Response(`bytes-${contentMatch[1]}`, { status: 200 });
    }

    return new Response("not found", { status: 404 });
  };

  return new CanvasClient(
    { baseUrl: "https://cdn.test", token: "t", schoolRoot: "/tmp", currentSemester: 5 },
    { fetchImpl, sleep: async () => {} }
  );
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

describe("syncCourse", () => {
  let schoolRoot: string;
  let prevEnv: Record<string, string | undefined>;

  beforeEach(() => {
    schoolRoot = mkdtempSync(join(tmpdir(), "canvas-mcp-engine-"));
    prevEnv = {
      CANVAS_TOKEN: process.env.CANVAS_TOKEN,
      CANVAS_BASE_URL: process.env.CANVAS_BASE_URL,
      SCHOOL_ROOT: process.env.SCHOOL_ROOT,
      CURRENT_SEMESTER: process.env.CURRENT_SEMESTER,
    };
    process.env.CANVAS_TOKEN = "t";
    process.env.CANVAS_BASE_URL = "https://cdn.test";
    process.env.SCHOOL_ROOT = schoolRoot;
    process.env.CURRENT_SEMESTER = "5";
  });

  afterEach(() => {
    rmSync(schoolRoot, { recursive: true, force: true });
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("downloads all files on first run, skips unchanged on second run, re-downloads changed files, and reports removals without deleting", async () => {
    const state = { files: baseFiles() };
    const dir = canvasDir("thyd", 5, { schoolRoot, baseUrl: "x", token: "t", currentSemester: 5 });

    // --- first run: 3 new files ---
    const first = await syncCourse(makeClient(state), COURSE);
    expect(first.added.sort()).toEqual([join("files", "a.pdf"), join("files", "b.pdf"), join("files", "c.pdf")].sort());
    expect(first.updated).toEqual([]);
    expect(first.skipped).toBe(0);
    expect(first.failed).toEqual([]);
    expect(existsSync(join(dir, "files", "a.pdf"))).toBe(true);
    expect(readFileSync(join(dir, "files", "a.pdf"), "utf-8")).toBe("bytes-101");

    // --- second run: nothing changed ---
    const second = await syncCourse(makeClient(state), COURSE);
    expect(second.added).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.skipped).toBe(3);
    expect(second.removedOnCanvas).toEqual([]);

    // --- third run: file 101's updated_at changes on Canvas ---
    state.files = state.files.map((f) => (f.id === 101 ? { ...f, updated_at: "2026-02-01T00:00:00Z" } : f));
    const third = await syncCourse(makeClient(state), COURSE);
    expect(third.updated).toEqual([join("files", "a.pdf")]);
    expect(third.added).toEqual([]);
    expect(third.skipped).toBe(2);

    // --- fourth run: file 103 disappears from Canvas ---
    state.files = state.files.filter((f) => f.id !== 103);
    const fourth = await syncCourse(makeClient(state), COURSE);
    expect(fourth.removedOnCanvas).toEqual([join("files", "c.pdf")]);
    expect(fourth.skipped).toBe(2);
    // never deleted from disk
    expect(existsSync(join(dir, "files", "c.pdf"))).toBe(true);
  });

  it("dry_run reports changes but writes nothing to disk", async () => {
    const state = { files: baseFiles() };
    const dir = canvasDir("thyd", 5, { schoolRoot, baseUrl: "x", token: "t", currentSemester: 5 });

    const report = await syncCourse(makeClient(state), COURSE, { dryRun: true });

    expect(report.added.length).toBe(3);
    expect(report.dryRun).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });
});
