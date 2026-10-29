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
  /** Canvas term start (ISO), e.g. "2026-08-01T00:00:00Z". null for "Default term" / unknown. */
  termStart: string | null;
  /** Canvas term end (ISO, exclusive), e.g. "2027-01-15T00:00:00Z". null for "Default term" / unknown. */
  termEnd: string | null;
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
  return {
    id: c.id,
    code: c.course_code,
    slug,
    name: c.name,
    term,
    semester: semesterFromTerm(term),
    termStart: c.term?.start_at ?? null,
    termEnd: c.term?.end_at ?? null,
  };
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

function parseTime(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function maxSemester(courses: CourseInfo[]): number | null {
  return courses.reduce<number | null>((m, c) => (c.semester !== null && (m === null || c.semester > m) ? c.semester : m), null);
}

/** "Today's term" by calendar alone: Haustönn for August–December, else Vorönn of that year. */
function calendarTerm(now: Date): string {
  return `${now.getUTCMonth() >= 7 ? "Haustönn" : "Vorönn"} ${now.getUTCFullYear()}`;
}

/**
 * The semester (önn) we are "in" at `now`, decided by Canvas term dates:
 *  1. if any course's term window contains `now` (start <= now < end), the highest such
 *     semester — so during the Jan 1–15 overlap the new Vorönn wins over the finishing Haustönn;
 *  2. else the highest semester whose term has already started (July → the Vorönn that just ended);
 *  3. else (no usable dates, or only future terms) a calendar rule: today's term is Haustönn in
 *     August–December, otherwise Vorönn; pick the highest semester <= that, or the lowest semester
 *     if every course is in the future (a brand-new student).
 * Courses enrolled for a future term therefore never displace the ongoing one. Returns null only
 * when no course has a derivable semester. Pure; `now` is injectable for tests.
 */
export function currentSemesterOf(courses: CourseInfo[], now: Date = new Date()): number | null {
  const candidates = courses.filter((c) => c.semester !== null);
  if (candidates.length === 0) return null;
  const t = now.getTime();

  const ongoing = candidates.filter((c) => {
    const start = parseTime(c.termStart);
    const end = parseTime(c.termEnd);
    return start !== null && end !== null && start <= t && t < end;
  });
  if (ongoing.length > 0) return maxSemester(ongoing);

  const started = candidates.filter((c) => {
    const start = parseTime(c.termStart);
    return start !== null && start <= t;
  });
  if (started.length > 0) return maxSemester(started);

  const today = semesterFromTerm(calendarTerm(now));
  const notFuture = today === null ? [] : candidates.filter((c) => c.semester! <= today);
  if (notFuture.length > 0) return maxSemester(notFuture);
  return candidates.reduce((m, c) => Math.min(m, c.semester!), Infinity);
}

/** Courses of the current semester (see currentSemesterOf). */
export async function currentCourses(client: CanvasClient, now: Date = new Date()): Promise<CourseInfo[]> {
  const all = await listCourses(client);
  const sem = currentSemesterOf(all, now);
  return all.filter((c) => c.semester === sem);
}

export class CourseNotFoundError extends Error {
  constructor(ref: string | number, available: CourseInfo[], now: Date = new Date()) {
    const currentSem = currentSemesterOf(available, now);
    const current = available.filter((c) => c.semester === currentSem).map((c) => c.slug);
    const hasOther = available.some((c) => c.semester !== currentSem);
    const currentPart =
      current.length > 0
        ? `Current courses: ${current.join(", ")}.`
        : `Available: ${available.map((c) => `${c.slug} (${c.id})`).join(", ")}.`;
    const pastNote = hasOther
      ? " (Other semesters are also searchable by slug — run list_courses with include_past: true to see them.)"
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
