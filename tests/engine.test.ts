import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CanvasClient } from "../src/canvas/client.js";
import type { CourseInfo } from "../src/canvas/courses.js";
import type { CanvasFile, Folder } from "../src/canvas/types.js";
import { syncCourse } from "../src/sync/engine.js";
import { PROJECT_ROOT, canvasDir, saveCourseMapping } from "../src/config.js";

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
      size: 9, // "bytes-101".length — must match the mock served content for local-edit detection to work.
      "content-type": "application/pdf",
      url: "https://cdn.test/content/101",
      updated_at: "2026-01-01T00:00:00Z",
    },
    {
      id: 102,
      display_name: "b.pdf",
      filename: "b.pdf",
      folder_id: 1,
      size: 9,
      "content-type": "application/pdf",
      url: "https://cdn.test/content/102",
      updated_at: "2026-01-01T00:00:00Z",
    },
    {
      id: 103,
      display_name: "c.pdf",
      filename: "c.pdf",
      folder_id: 1,
      size: 9,
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

// ---------------------------------------------------------------------------
// Shared helpers for the additional coverage below: a schoolRoot+env fixture
// factored out of the describe block above so each new describe can use it
// independently, and a client mock that also serves modules/pages/folders.
// ---------------------------------------------------------------------------

function useSchoolRoot(): { get: () => string } {
  let root = "";
  let prevEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "canvas-mcp-engine-"));
    prevEnv = {
      CANVAS_TOKEN: process.env.CANVAS_TOKEN,
      CANVAS_BASE_URL: process.env.CANVAS_BASE_URL,
      SCHOOL_ROOT: process.env.SCHOOL_ROOT,
      CURRENT_SEMESTER: process.env.CURRENT_SEMESTER,
    };
    process.env.CANVAS_TOKEN = "t";
    process.env.CANVAS_BASE_URL = "https://cdn.test";
    process.env.SCHOOL_ROOT = root;
    process.env.CURRENT_SEMESTER = "5";
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  return { get: () => root };
}

interface RawPage {
  url: string;
  title: string;
  updated_at?: string;
  front_page?: boolean;
}

interface RawPageBody {
  url: string;
  title: string;
  body: string;
  updated_at?: string;
}

interface FullState {
  files: CanvasFile[];
  folders?: Folder[];
  modules?: unknown[];
  pages?: RawPage[];
  pageBodies?: Record<string, RawPageBody>;
  /** Override the served download content for a file id (default: `bytes-<id>`). */
  fileContents?: Record<number, string>;
}

/** Like makeClient, but also serves /modules, /pages, and /pages/:url — for tests exercising the whole engine. */
function makeFullClient(courseId: number, state: FullState): CanvasClient {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const path = url.pathname;

    if (path === `/api/v1/courses/${courseId}/folders`) return jsonResponse(state.folders ?? [ROOT_FOLDER]);
    if (path === `/api/v1/courses/${courseId}/files`) return jsonResponse(state.files);
    if (path === `/api/v1/courses/${courseId}/modules`) return jsonResponse(state.modules ?? []);
    if (path === `/api/v1/courses/${courseId}/pages`) return jsonResponse(state.pages ?? []);

    const pageBodyMatch = path.match(new RegExp(`^/api/v1/courses/${courseId}/pages/(.+)$`));
    if (pageBodyMatch) {
      const pageUrl = decodeURIComponent(pageBodyMatch[1]!);
      const body = state.pageBodies?.[pageUrl];
      if (!body) return new Response("not found", { status: 404 });
      return jsonResponse(body);
    }

    const fileMatch = path.match(/^\/api\/v1\/files\/(\d+)$/);
    if (fileMatch) {
      const f = state.files.find((x) => x.id === Number(fileMatch[1]));
      if (!f) return new Response("not found", { status: 404 });
      return jsonResponse(f);
    }

    const contentMatch = path.match(/^\/content\/(\d+)$/);
    if (contentMatch) {
      const id = Number(contentMatch[1]);
      return new Response(state.fileContents?.[id] ?? `bytes-${id}`, { status: 200 });
    }

    return new Response("not found", { status: 404 });
  };

  return new CanvasClient(
    { baseUrl: "https://cdn.test", token: "t", schoolRoot: "/tmp", currentSemester: 5 },
    { fetchImpl, sleep: async () => {} }
  );
}

function pdfFile(id: number, displayName: string, opts: Partial<CanvasFile> = {}): CanvasFile {
  return {
    id,
    display_name: displayName,
    filename: displayName,
    folder_id: 1,
    size: `bytes-${id}`.length,
    "content-type": "application/pdf",
    url: `https://cdn.test/content/${id}`,
    updated_at: "2026-01-01T00:00:00Z",
    ...opts,
  };
}

describe("syncCourse — degenerate Canvas names (P0-1 / empty display_name)", () => {
  const root = useSchoolRoot();

  it("gives '..', empty, and '.' display_names safe fallback names, and never writes outside canvasDir", async () => {
    const files: CanvasFile[] = [
      pdfFile(501, ".."),
      pdfFile(502, ""),
      pdfFile(503, "."),
    ];
    const state: FullState = { files };
    const schoolRoot = root.get();
    const dir = canvasDir("thyd", 5, { schoolRoot, baseUrl: "x", token: "t", currentSemester: 5 });
    const courseDirAbs = join(schoolRoot, "onn 5", "thyd");

    // Canary that must survive completely untouched — this is exactly the
    // path a `.part` sidecar for a `display_name: ".."` file used to land on.
    mkdirSync(courseDirAbs, { recursive: true });
    writeFileSync(join(courseDirAbs, "canvas.part"), "canary-part");

    const report = await syncCourse(makeFullClient(1, state), COURSE);

    expect(report.failed).toEqual([]);
    expect(existsSync(join(dir, "files", "file-501.pdf"))).toBe(true);
    expect(existsSync(join(dir, "files", "file-502.pdf"))).toBe(true);
    expect(existsSync(join(dir, "files", "file-503.pdf"))).toBe(true);
    expect(readFileSync(join(dir, "files", "file-501.pdf"), "utf-8")).toBe("bytes-501");

    // Canary and the canvas/ dir itself are untouched.
    expect(readFileSync(join(courseDirAbs, "canvas.part"), "utf-8")).toBe("canary-part");
    expect(existsSync(join(courseDirAbs, "canvas"))).toBe(true);
    expect(statSync(join(courseDirAbs, "canvas")).isDirectory()).toBe(true);
  });
});

describe("syncCourse — symlink escape protection (P1-5)", () => {
  const root = useSchoolRoot();

  it("refuses to write through a symlinked canvas/files dir, and nothing escapes SCHOOL_ROOT", async () => {
    const state: FullState = { files: baseFiles() };
    const schoolRoot = root.get();
    const dir = canvasDir("thyd", 5, { schoolRoot, baseUrl: "x", token: "t", currentSemester: 5 });
    const outside = mkdtempSync(join(tmpdir(), "canvas-mcp-outside-"));

    try {
      mkdirSync(dir, { recursive: true });
      symlinkSync(outside, join(dir, "files"));

      const report = await syncCourse(makeFullClient(1, state), COURSE);

      expect(report.failed.length).toBe(3);
      for (const f of report.failed) {
        expect(f.error).toMatch(/symlink/i);
      }
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("syncCourse — module links never clobber a user's own file (P1-3)", () => {
  const root = useSchoolRoot();

  it("leaves a pre-existing regular file at a module link path untouched and reports it", async () => {
    const files: CanvasFile[] = [pdfFile(601, "lecture.pdf")];
    const modules = [
      { id: 1, name: "Week 1", position: 1, items: [{ id: 10, title: "Lecture", type: "File", content_id: 601 }] },
    ];
    const state: FullState = { files, modules };
    const schoolRoot = root.get();
    const dir = canvasDir("thyd", 5, { schoolRoot, baseUrl: "x", token: "t", currentSemester: 5 });
    const linkAbs = join(dir, "modules", "01 - Week 1", "01 - Lecture.pdf");

    mkdirSync(dirname(linkAbs), { recursive: true });
    writeFileSync(linkAbs, "my own annotated copy");

    const report = await syncCourse(makeFullClient(1, state), COURSE);

    expect(readFileSync(linkAbs, "utf-8")).toBe("my own annotated copy");
    expect(report.warnings.some((w) => w.includes("user file exists"))).toBe(true);
  });

  it("replaces a stale symlink left by a previous sync", async () => {
    const files: CanvasFile[] = [pdfFile(602, "lecture.pdf")];
    const modules = [
      { id: 1, name: "Week 1", position: 1, items: [{ id: 10, title: "Lecture", type: "File", content_id: 602 }] },
    ];
    const state: FullState = { files, modules };

    // First run creates the real symlink; second run must succeed by
    // replacing it (it's a symlink, not a user file) rather than skipping.
    await syncCourse(makeFullClient(1, state), COURSE);
    const report = await syncCourse(makeFullClient(1, state), COURSE);

    expect(report.warnings.some((w) => w.includes("user file exists"))).toBe(false);
  });
});

describe("syncCourse — sticky duplicate file naming (P1-4)", () => {
  const root = useSchoolRoot();

  it("keeps a duplicate's suffixed path across runs even after its sibling disappears, and a fresh duplicate is also suffixed", async () => {
    const dup = (id: number, updatedAt = "2026-01-01T00:00:00Z"): CanvasFile => pdfFile(id, "slides.pdf", { updated_at: updatedAt });

    const state: FullState = { files: [dup(4), dup(9)] };
    const schoolRoot = root.get();
    const dir = canvasDir("thyd", 5, { schoolRoot, baseUrl: "x", token: "t", currentSemester: 5 });

    const first = await syncCourse(makeFullClient(1, state), COURSE);
    expect(first.added.sort()).toEqual([join("files", "slides (9).pdf"), join("files", "slides.pdf")].sort());
    expect(existsSync(join(dir, "files", "slides.pdf"))).toBe(true);
    expect(existsSync(join(dir, "files", "slides (9).pdf"))).toBe(true);

    // id 4 disappears from Canvas; id 9 gets updated.
    state.files = [dup(9, "2026-02-01T00:00:00Z")];
    const second = await syncCourse(makeFullClient(1, state), COURSE);
    expect(second.updated).toEqual([join("files", "slides (9).pdf")]);
    expect(second.removedOnCanvas).toEqual([join("files", "slides.pdf")]);
    // The survivor's path/bytes are unaffected — never reassigned onto id 4's old plain-name path.
    expect(readFileSync(join(dir, "files", "slides.pdf"), "utf-8")).toBe("bytes-4");
    expect(readFileSync(join(dir, "files", "slides (9).pdf"), "utf-8")).toBe("bytes-9");

    // A brand-new duplicate arrives. id 4's manifest entry still claims the
    // plain name (its file is still on disk), so the newcomer must be
    // suffixed rather than silently overwrite it.
    state.files = [...state.files, dup(10)];
    const third = await syncCourse(makeFullClient(1, state), COURSE);
    expect(third.added).toEqual([join("files", "slides (10).pdf")]);
    expect(third.skipped).toBe(1);
    expect(readFileSync(join(dir, "files", "slides.pdf"), "utf-8")).toBe("bytes-4");
  });
});

describe("syncCourse — preserves a locally-edited file instead of overwriting it (P1-6)", () => {
  const root = useSchoolRoot();

  it("keeps the user's edited bytes and saves Canvas's new version alongside, with a warning", async () => {
    const file = pdfFile(701, "notes.pdf");
    const state: FullState = { files: [file] };
    const schoolRoot = root.get();
    const dir = canvasDir("thyd", 5, { schoolRoot, baseUrl: "x", token: "t", currentSemester: 5 });

    await syncCourse(makeFullClient(1, state), COURSE);
    const notesPath = join(dir, "files", "notes.pdf");
    expect(readFileSync(notesPath, "utf-8")).toBe("bytes-701");

    // The user edits the file locally — different size than what we recorded.
    writeFileSync(notesPath, "my own annotated version, much longer than the original download");

    // Canvas has a new version.
    state.files = [{ ...file, updated_at: "2026-03-15T00:00:00Z" }];
    const report = await syncCourse(makeFullClient(1, state), COURSE);

    expect(readFileSync(notesPath, "utf-8")).toBe(
      "my own annotated version, much longer than the original download"
    );
    const canvasCopyPath = join(dir, "files", "notes (canvas 2026-03-15).pdf");
    expect(existsSync(canvasCopyPath)).toBe(true);
    expect(readFileSync(canvasCopyPath, "utf-8")).toBe("bytes-701");
    expect(report.warnings.some((w) => w.includes("kept your edited copy"))).toBe(true);
    expect(report.updated).toEqual([]);
    expect(report.added).toEqual([]);
  });
});

describe("syncCourse — pages named by url slug (lead-live: triplicate titles)", () => {
  const root = useSchoolRoot();

  it("gives triplicate-titled pages 3 stable filenames from their url, and skips them unchanged on a second run", async () => {
    const pages: RawPage[] = [
      { url: "assessment", title: "Assessment", updated_at: "2026-01-01T00:00:00Z", front_page: false },
      { url: "assessment-2", title: "Assessment", updated_at: "2026-01-01T00:00:00Z", front_page: false },
      { url: "assessment-3", title: "Assessment", updated_at: "2026-01-01T00:00:00Z", front_page: false },
    ];
    const pageBodies: Record<string, RawPageBody> = {
      assessment: { url: "assessment", title: "Assessment", body: "<p>one</p>", updated_at: "2026-01-01T00:00:00Z" },
      "assessment-2": {
        url: "assessment-2",
        title: "Assessment",
        body: "<p>two</p>",
        updated_at: "2026-01-01T00:00:00Z",
      },
      "assessment-3": {
        url: "assessment-3",
        title: "Assessment",
        body: "<p>three</p>",
        updated_at: "2026-01-01T00:00:00Z",
      },
    };
    const state: FullState = { files: [], pages, pageBodies };
    const schoolRoot = root.get();
    const dir = canvasDir("thyd", 5, { schoolRoot, baseUrl: "x", token: "t", currentSemester: 5 });

    const first = await syncCourse(makeFullClient(1, state), COURSE);
    expect(first.added.sort()).toEqual(
      [join("pages", "assessment.md"), join("pages", "assessment-2.md"), join("pages", "assessment-3.md")].sort()
    );
    expect(readFileSync(join(dir, "pages", "assessment-2.md"), "utf-8")).toContain("two");
    expect(readFileSync(join(dir, "pages", "assessment-3.md"), "utf-8")).toContain("three");

    const second = await syncCourse(makeFullClient(1, state), COURSE);
    expect(second.added).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.skipped).toBe(3);
  });
});

describe("syncCourse — dry run covers modules and pages, not just files (P2)", () => {
  const root = useSchoolRoot();

  it("reports intended module/page writes without creating the canvas/ dir at all", async () => {
    const files: CanvasFile[] = [pdfFile(801, "Lecture.pdf")];
    const modules = [
      {
        id: 1,
        name: "Week 1",
        position: 1,
        items: [
          { id: 10, title: "Lecture Slides", type: "File", content_id: 801 },
          { id: 11, title: "Reading", type: "ExternalUrl", external_url: "https://example.com/reading" },
        ],
      },
    ];
    const pages: RawPage[] = [{ url: "week-1", title: "Week 1", updated_at: "2026-01-01T00:00:00Z", front_page: false }];
    const pageBodies: Record<string, RawPageBody> = {
      "week-1": { url: "week-1", title: "Week 1", body: "<p>hi</p>", updated_at: "2026-01-01T00:00:00Z" },
    };
    const state: FullState = { files, modules, pages, pageBodies };
    const schoolRoot = root.get();
    const dir = canvasDir("thyd", 5, { schoolRoot, baseUrl: "x", token: "t", currentSemester: 5 });

    const report = await syncCourse(makeFullClient(1, state), COURSE, { dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.added).toContain(join("modules", "01 - Week 1", "01 - Lecture Slides.pdf"));
    expect(report.added).toContain(join("modules", "01 - Week 1", "links.md"));
    expect(report.added).toContain(join("pages", "week-1.md"));
    expect(existsSync(dir)).toBe(false);
  });
});

describe("syncCourse — full idempotency across files, pages, and modules", () => {
  const root = useSchoolRoot();

  it("second run adds/updates/fails nothing once files, pages, and module links are all in place", async () => {
    const files: CanvasFile[] = [pdfFile(901, "Lecture.pdf")];
    const modules = [
      {
        id: 1,
        name: "Week 1",
        position: 1,
        items: [
          { id: 10, title: "Lecture Slides", type: "File", content_id: 901 },
          { id: 11, title: "Reading", type: "ExternalUrl", external_url: "https://example.com/reading" },
        ],
      },
    ];
    const pages: RawPage[] = [{ url: "week-1", title: "Week 1", updated_at: "2026-01-01T00:00:00Z", front_page: false }];
    const pageBodies: Record<string, RawPageBody> = {
      "week-1": { url: "week-1", title: "Week 1", body: "<p>hi</p>", updated_at: "2026-01-01T00:00:00Z" },
    };
    const state: FullState = { files, modules, pages, pageBodies };
    const schoolRoot = root.get();
    const dir = canvasDir("thyd", 5, { schoolRoot, baseUrl: "x", token: "t", currentSemester: 5 });

    const first = await syncCourse(makeFullClient(1, state), COURSE);
    expect(first.failed).toEqual([]);
    expect(existsSync(join(dir, "files", "Lecture.pdf"))).toBe(true);
    expect(existsSync(join(dir, "pages", "week-1.md"))).toBe(true);
    expect(existsSync(join(dir, "modules", "01 - Week 1", "01 - Lecture Slides.pdf"))).toBe(true);
    expect(existsSync(join(dir, "modules", "01 - Week 1", "links.md"))).toBe(true);

    const second = await syncCourse(makeFullClient(1, state), COURSE);
    expect(second.added).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.failed).toEqual([]);
    expect(second.skipped).toBe(2); // the file + the page; module links aren't manifest-skip-tracked but must not fail or warn.
    expect(second.warnings).toEqual([]);
  });
});

describe("syncCourse — config/courses.json mapping overrides the derived slug/semester (P2)", () => {
  const root = useSchoolRoot();
  const mappingFile = join(PROJECT_ROOT, "config", "courses.json");
  let backup: string | null;

  beforeEach(() => {
    backup = existsSync(mappingFile) ? readFileSync(mappingFile, "utf-8") : null;
  });

  afterEach(() => {
    if (backup === null) rmSync(mappingFile, { force: true });
    else writeFileSync(mappingFile, backup);
  });

  it("writes under the mapped slug/semester instead of the course's own derived ones", async () => {
    saveCourseMapping({ "1": { code: COURSE.code, slug: "mapped-slug", semester: 7 } });

    const state: FullState = { files: baseFiles() };
    const schoolRoot = root.get();
    const report = await syncCourse(makeFullClient(1, state), COURSE);

    const mappedDir = canvasDir("mapped-slug", 7, {
      schoolRoot,
      baseUrl: "x",
      token: "t",
      currentSemester: 5,
    });
    expect(report.dir).toBe(mappedDir);
    expect(report.slug).toBe("mapped-slug");
    expect(existsSync(join(mappedDir, "files", "a.pdf"))).toBe(true);
  });
});
