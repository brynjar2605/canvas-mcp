import type { CanvasClient } from "./client.js";
import type { Course } from "./types.js";
import { loadCourseMapping, type CourseMapping, type CourseMappingEntry } from "../config.js";


/** Compact, LLM-friendly course record used across all tools. */
export interface CourseInfo {
  id: number;
  /** Canvas course_code, e.g. "T-603-THYD". */
  code: string;
  /** Lowercased last segment of the code, e.g. "thyd". Used as folder name. */
  slug: string;
  name: string;
  /** Term name, e.g. "Haustönn 2026". null when Canvas gave none / "Default term". */
  term: string | null;
  /** Derived semester number (önn), 1-based from FIRST_TERM. null when not derivable. */
  semester: number | null;
}

/** Real RU courses look like T-603-THYD or X-204-STOF. Anything else is an announcement/video shell. */
const COURSE_CODE_RE = /^([A-Z])-(\d{3})-([A-Z0-9]+)$/;

export function slugFromCode(code: string | undefined | null): string | null {
  if (!code) return null;
  const m = COURSE_CODE_RE.exec(code.trim());
  return m ? m[3]!.toLowerCase() : null;
}

const TERM_RE = /^(Haustönn|Vorönn)\s+(\d{4})$/;

/** Term index: two terms per year — Vorönn (spring) = 0, Haustönn (autumn) = 1. */
function termIndex(term: string): number | null {
  const m = TERM_RE.exec(term.trim());
  if (!m) return null;
  return Number(m[2]) * 2 + (m[1] === "Haustönn" ? 1 : 0);
}

export const DEFAULT_FIRST_TERM = "Haustönn 2024";

/**
 * Semester (önn) number derived from a term name, 1-based from `firstTerm`.
 * "Haustönn 2024" → 1, "Vorönn 2025" → 2, "Haustönn 2026" → 5. Returns null for
 * "Default term" or anything before firstTerm.
 */
export function semesterFromTerm(
  term: string | undefined | null,
  firstTerm: string = process.env.FIRST_TERM || DEFAULT_FIRST_TERM,
): number | null {
  if (!term) return null;
  const t = termIndex(term);
  const f = termIndex(firstTerm);
  if (t === null || f === null || t < f) return null;
  return t - f + 1;
}

export function toCourseInfo(c: Course): CourseInfo | null {
  const slug = slugFromCode(c.course_code);
  if (!slug) return null;
  const term = c.term?.name && c.term.name !== "Default term" ? c.term.name : null;
  return { id: c.id, code: c.course_code, slug, name: c.name, term, semester: semesterFromTerm(term) };
}

const COURSES_TTL_MS = 60 * 60 * 1000;

/**
 * All real courses the user is/was enrolled in, newest semester first.
 * Junk "courses" (RU-ANNOUNCE, video shells) are filtered out.
 */
export async function listCourses(client: CanvasClient): Promise<CourseInfo[]> {
  const raw = await client.getAll<Course>(
    "/api/v1/courses",
    { include: ["term"], state: ["available", "completed"] },
    COURSES_TTL_MS,
  );
  return raw
    .map(toCourseInfo)
    .filter((c): c is CourseInfo => c !== null)
    .sort((a, b) => (b.semester ?? 0) - (a.semester ?? 0) || a.slug.localeCompare(b.slug));
}

/** Highest derived semester across all courses — the semester we are "in". */
export function currentSemesterOf(courses: CourseInfo[]): number | null {
  return courses.reduce<number | null>((max, c) => (c.semester !== null && (max === null || c.semester > max) ? c.semester : max), null);
}

/** Courses of the current (highest) semester. */
export async function currentCourses(client: CanvasClient): Promise<CourseInfo[]> {
  const all = await listCourses(client);
  const sem = currentSemesterOf(all);
  return all.filter((c) => c.semester === sem);
}

export class CourseNotFoundError extends Error {
  constructor(ref: string | number, available: CourseInfo[]) {
    const currentSem = currentSemesterOf(available);
    const current = available.filter((c) => c.semester === currentSem).map((c) => c.slug);
    const hasOlder = available.some((c) => c.semester !== currentSem);
    const currentPart =
      current.length > 0
        ? `Current courses: ${current.join(", ")}.`
        : `Available: ${available.map((c) => `${c.slug} (${c.id})`).join(", ")}.`;
    const pastNote = hasOlder
      ? " (Older semesters are also searchable by slug — run list_courses with include_past: true to see them.)"
      : "";
    super(`No course matches "${ref}". ${currentPart}${pastNote}`);
    this.name = "CourseNotFoundError";
  }
}

/**
 * Resolve a user-supplied course reference against, in order:
 *  1. numeric id, slug ("thyd"), or full code ("T-603-THYD") — case-insensitive, exact.
 *  2. the local folder name recorded in `config/courses.json` by apply_course_mapping
 *     (e.g. "compilers" mapped to "thyd") — case-insensitive, exact.
 *  3. a case-insensitive substring (>= 4 chars) of the course's display name — only
 *     when that substring is unique across all courses, so "Þýðendur" or "styrikerfi"
 *     works without risking a wrong match on a short, ambiguous fragment.
 * Prefers the current semester when a slug repeats across semesters. `courseMapping`
 * defaults to reading `config/courses.json`; tests can inject a fake one directly.
 */
export async function resolveCourse(
  client: CanvasClient,
  ref: string | number,
  courseMapping: CourseMapping = loadCourseMapping(),
): Promise<CourseInfo> {
  const all = await listCourses(client);
  const s = String(ref).trim().toLowerCase();
  const asId = Number(s);

  const exact = all.filter((c) => c.id === asId || c.slug === s || c.code.toLowerCase() === s);
  if (exact.length > 0) return exact[0]!; // listCourses is sorted newest-semester first

  for (const entry of Object.values(courseMapping)) {
    if (entry.folder && entry.folder.trim().toLowerCase() === s) {
      const bySlug = all.find((c) => c.slug === entry.slug);
      if (bySlug) return bySlug;
    }
  }

  if (s.length >= 4) {
    const nameMatches = all.filter((c) => c.name.toLowerCase().includes(s));
    if (nameMatches.length === 1) return nameMatches[0]!;
  }

  throw new CourseNotFoundError(ref, all);
}
