import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Resolve paths relative to this file's location, NOT process.cwd() — MCP
// servers are launched by clients (Claude Desktop, Claude Code, etc.) from
// arbitrary working directories, so cwd-relative paths would be wrong.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// src/config.ts -> project root is one directory up.
export const PROJECT_ROOT = join(__dirname, "..");
const ENV_PATH = join(PROJECT_ROOT, ".env");
const COURSES_JSON_PATH = join(PROJECT_ROOT, "config", "courses.json");

let envLoaded = false;
function ensureEnvLoaded(): void {
  if (envLoaded) return;
  if (existsSync(ENV_PATH)) {
    dotenv.config({ path: ENV_PATH });
  }
  envLoaded = true;
}

export interface Config {
  baseUrl: string;
  token: string;
  schoolRoot: string;
  /** Optional fallback semester (önn) when a course has no derivable term. */
  currentSemester: number | null;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Loads and validates configuration from environment variables (populated
 * from .env at the project root, if present). Throws ConfigError with a
 * clear, actionable message if required values are missing or invalid.
 *
 * Never includes the token value itself in any error message.
 */
export function getConfig(): Config {
  ensureEnvLoaded();

  const token = process.env.CANVAS_TOKEN;
  if (!token || token.trim().length === 0) {
    throw new ConfigError(
      "CANVAS_TOKEN is missing. Set it in your .env file at the project root " +
        "(see .env.example) or as an environment variable before starting canvas-mcp."
    );
  }

  const baseUrl = process.env.CANVAS_BASE_URL || "https://reykjavik.instructure.com";

  const schoolRoot = process.env.SCHOOL_ROOT;
  if (!schoolRoot || schoolRoot.trim().length === 0) {
    throw new ConfigError(
      "SCHOOL_ROOT is missing. Set it in your .env file (e.g. " +
        "SCHOOL_ROOT=/Users/you/Documents/Tolvunarfraedi)."
    );
  }

  // Optional fallback only: the semester is normally derived from each course's term
  // (see canvas/courses.ts semesterFromTerm). Used when a course has no derivable term.
  const currentSemesterRaw = process.env.CURRENT_SEMESTER?.trim();
  let currentSemester: number | null = null;
  if (currentSemesterRaw) {
    currentSemester = Number(currentSemesterRaw);
    if (!Number.isFinite(currentSemester) || !Number.isInteger(currentSemester)) {
      throw new ConfigError(
        `CURRENT_SEMESTER must be an integer if set, got: ${JSON.stringify(currentSemesterRaw)}`
      );
    }
  }

  return { baseUrl, token, schoolRoot, currentSemester };
}

/** `<schoolRoot>/onn <n>` */
export function semesterDir(n: number, cfg: Pick<Config, "schoolRoot"> = getConfig()): string {
  return join(cfg.schoolRoot, `onn ${n}`);
}

/** `<schoolRoot>/onn <semester>/<slug>` */
export function courseDir(
  slug: string,
  semester: number,
  cfg: Pick<Config, "schoolRoot"> = getConfig()
): string {
  return join(semesterDir(semester, cfg), slug);
}

/** `<courseDir>/canvas` */
export function canvasDir(
  slug: string,
  semester: number,
  cfg: Pick<Config, "schoolRoot"> = getConfig()
): string {
  return join(courseDir(slug, semester, cfg), "canvas");
}

export interface CourseMappingEntry {
  code: string;
  slug: string;
  semester: number;
  /**
   * Local folder name the course had before apply_course_mapping renamed it
   * (e.g. "compilers"); lets the user keep referring to it by that name.
   */
  folder?: string;
}

/** Shape of config/courses.json: canvas course id (as string) -> mapping entry. */
export type CourseMapping = Record<string, CourseMappingEntry>;

/**
 * Loads config/courses.json (relative to the project root). Returns an
 * empty map if the file does not exist yet.
 */
export function loadCourseMapping(path: string = COURSES_JSON_PATH): CourseMapping {
  if (!existsSync(path)) {
    return {};
  }
  const raw = readFileSync(path, "utf-8");
  if (raw.trim().length === 0) {
    return {};
  }
  return JSON.parse(raw) as CourseMapping;
}

/** Writes config/courses.json (relative to the project root), creating the directory if needed. */
export function saveCourseMapping(
  mapping: CourseMapping,
  path: string = COURSES_JSON_PATH
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(mapping, null, 2) + "\n", "utf-8");
}

export interface CourseFolderInfo {
  slug: string;
  semester: number;
  /** `<courseDir>/canvas`, honouring the courses.json mapping when present. */
  dir: string;
}

/**
 * Resolves the on-disk canvas/ folder for a course, consulting
 * `config/courses.json` FIRST: if the course id has a mapping entry, its
 * slug + semester win over the live/derived ones (this is what makes
 * `apply_course_mapping` actually take effect, and what keeps sync pointed
 * at the right folder if `FIRST_TERM` — and therefore every course's derived
 * semester — ever changes). Falls back to the course's own slug/semester
 * when there is no mapping entry.
 *
 * Throws ConfigError if neither the mapping nor the course itself can supply
 * a semester.
 */
export function folderForCourse(
  course: { id: number; slug: string; semester: number | null },
  cfg: Config = getConfig(),
  mappingPath?: string
): CourseFolderInfo {
  const mapping = loadCourseMapping(mappingPath);
  const entry = mapping[String(course.id)];
  // `entry.folder` (if present) is only an alias for resolveCourse() lookups
  // — it never affects the on-disk path, so it's deliberately not read here.
  const slug = entry?.slug ?? course.slug;
  const semester = entry?.semester ?? course.semester;

  if (semester === null || semester === undefined) {
    throw new ConfigError(
      `Course "${course.slug}" has no derivable semester and no config/courses.json mapping; cannot locate its canvas/ dir.`
    );
  }

  return { slug, semester, dir: canvasDir(slug, semester, cfg) };
}
