import type { CanvasClient } from "./client.js";
import type { CourseInfo } from "./courses.js";
import type { Announcement } from "./types.js";
import { htmlToMarkdown } from "../util/html.js";

export interface AnnouncementSummary {
  id: number;
  courseSlug: string;
  courseId: number;
  title: string;
  postedAt: string | null;
  bodyMarkdown: string;
  htmlUrl: string;
}

export const DEFAULT_ANNOUNCEMENT_DAYS = 30;
const CONTEXT_CODES_CHUNK_SIZE = 10;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function courseIdFromContextCode(contextCode: string): number | null {
  const m = /^course_(\d+)$/.exec(contextCode);
  return m ? Number(m[1]) : null;
}

function toSummary(a: Announcement, byId: Map<number, CourseInfo>): AnnouncementSummary | null {
  const courseId = courseIdFromContextCode(a.context_code);
  const course = courseId !== null ? byId.get(courseId) : undefined;
  // Skip announcements from contexts we can't map back to a known course
  // (e.g. an account-wide announcement matched by an odd context code).
  if (!course) return null;
  return {
    id: a.id,
    courseSlug: course.slug,
    courseId: course.id,
    title: a.title,
    postedAt: a.posted_at ?? null,
    bodyMarkdown: htmlToMarkdown(a.message),
    htmlUrl: a.html_url,
  };
}

/**
 * Lists announcements across the given courses from the last `days` days
 * (default 30), newest first. Canvas's `/api/v1/announcements` defaults
 * `end_date` to today and requires an explicit `start_date` to reach back
 * further, so both are always passed explicitly here.
 */
export async function listAnnouncements(
  client: CanvasClient,
  courses: CourseInfo[],
  days: number = DEFAULT_ANNOUNCEMENT_DAYS,
): Promise<AnnouncementSummary[]> {
  if (courses.length === 0) return [];

  const byId = new Map(courses.map((c) => [c.id, c]));
  const now = new Date();
  const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const endDate = now.toISOString();

  const results: AnnouncementSummary[] = [];
  for (const group of chunk(courses, CONTEXT_CODES_CHUNK_SIZE)) {
    const contextCodes = group.map((c) => `course_${c.id}`);
    const raw = await client.getAll<Announcement>("/api/v1/announcements", {
      context_codes: contextCodes,
      start_date: startDate,
      end_date: endDate,
    });
    for (const a of raw) {
      const summary = toSummary(a, byId);
      if (summary) results.push(summary);
    }
  }

  return results.sort((a, b) => {
    if (a.postedAt === null && b.postedAt === null) return 0;
    if (a.postedAt === null) return 1;
    if (b.postedAt === null) return -1;
    return new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime();
  });
}
