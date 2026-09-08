import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  canvasDir,
  courseDir,
  getConfig,
  loadCourseMapping,
  saveCourseMapping,
  semesterDir,
  type CourseMapping,
} from "../src/config.js";

const ENV_KEYS = ["CANVAS_TOKEN", "CANVAS_BASE_URL", "SCHOOL_ROOT", "CURRENT_SEMESTER"] as const;

describe("config path helpers", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canvas-mcp-school-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("semesterDir builds '<schoolRoot>/onn <n>'", () => {
    expect(semesterDir(5, { schoolRoot: tmpDir })).toBe(join(tmpDir, "onn 5"));
  });

  it("courseDir builds '<schoolRoot>/onn <semester>/<slug>'", () => {
    expect(courseDir("thyd", 5, { schoolRoot: tmpDir })).toBe(join(tmpDir, "onn 5", "thyd"));
  });

  it("canvasDir builds '<courseDir>/canvas'", () => {
    expect(canvasDir("thyd", 5, { schoolRoot: tmpDir })).toBe(join(tmpDir, "onn 5", "thyd", "canvas"));
  });

  it("path helpers fall back to getConfig()'s schoolRoot (overridden via env) when no cfg is passed", () => {
    const saved: Record<string, string | undefined> = {};
    for (const key of ENV_KEYS) saved[key] = process.env[key];

    process.env.CANVAS_TOKEN = "test-token";
    process.env.CANVAS_BASE_URL = "https://example.instructure.com";
    process.env.SCHOOL_ROOT = tmpDir;
    process.env.CURRENT_SEMESTER = "5";

    try {
      expect(semesterDir(5)).toBe(join(tmpDir, "onn 5"));
    } finally {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
});

describe("getConfig", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("throws ConfigError when CANVAS_TOKEN is missing", () => {
    process.env.SCHOOL_ROOT = "/tmp/school";
    process.env.CURRENT_SEMESTER = "5";
    expect(() => getConfig()).toThrow(ConfigError);
  });

  it("error message never contains the token value", () => {
    process.env.CANVAS_TOKEN = "super-secret-token-value";
    // Force another required field to be missing so validation still throws.
    delete process.env.SCHOOL_ROOT;
    try {
      getConfig();
      expect.fail("expected getConfig to throw");
    } catch (err) {
      expect(String((err as Error).message)).not.toContain("super-secret-token-value");
    }
  });

  it("returns a valid config when all required env vars are set", () => {
    process.env.CANVAS_TOKEN = "test-token";
    process.env.CANVAS_BASE_URL = "https://example.instructure.com";
    process.env.SCHOOL_ROOT = "/tmp/school";
    process.env.CURRENT_SEMESTER = "5";

    const cfg = getConfig();
    expect(cfg).toEqual({
      token: "test-token",
      baseUrl: "https://example.instructure.com",
      schoolRoot: "/tmp/school",
      currentSemester: 5,
    });
  });

  it("defaults CANVAS_BASE_URL when not set", () => {
    process.env.CANVAS_TOKEN = "test-token";
    process.env.SCHOOL_ROOT = "/tmp/school";
    process.env.CURRENT_SEMESTER = "5";
    delete process.env.CANVAS_BASE_URL;

    const cfg = getConfig();
    expect(cfg.baseUrl).toBe("https://reykjavik.instructure.com");
  });

  it("throws ConfigError when CURRENT_SEMESTER is not an integer", () => {
    process.env.CANVAS_TOKEN = "test-token";
    process.env.SCHOOL_ROOT = "/tmp/school";
    process.env.CURRENT_SEMESTER = "not-a-number";
    expect(() => getConfig()).toThrow(ConfigError);
  });
});

describe("course mapping (config/courses.json)", () => {
  let tmpDir: string;
  let mappingPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canvas-mcp-config-"));
    mappingPath = join(tmpDir, "config", "courses.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns an empty map when the file does not exist", () => {
    expect(loadCourseMapping(mappingPath)).toEqual({});
  });

  it("round-trips through save and load", () => {
    const mapping: CourseMapping = {
      "12345": { code: "T-603-THYD", slug: "thyd", semester: 5 },
      "67890": { code: "T-720-VEFT", slug: "veft", semester: 5 },
    };

    saveCourseMapping(mapping, mappingPath);
    const loaded = loadCourseMapping(mappingPath);

    expect(loaded).toEqual(mapping);
  });

  it("round-trips an entry that carries a folder alias", () => {
    const mapping: CourseMapping = {
      "10495": { code: "T-603-THYD", slug: "thyd", semester: 5, folder: "compilers" },
    };

    saveCourseMapping(mapping, mappingPath);
    const loaded = loadCourseMapping(mappingPath);

    expect(loaded).toEqual(mapping);
    expect(loaded["10495"]!.folder).toBe("compilers");
  });

  it("loads legacy entries that predate the folder field", async () => {
    await mkdir(join(tmpDir, "config"), { recursive: true });
    await writeFile(
      mappingPath,
      JSON.stringify({ "10488": { code: "T-503-POSH", slug: "posh", semester: 5 } }),
      "utf-8"
    );

    const loaded = loadCourseMapping(mappingPath);

    expect(loaded["10488"]).toEqual({ code: "T-503-POSH", slug: "posh", semester: 5 });
    expect(loaded["10488"]!.folder).toBeUndefined();
  });
});
