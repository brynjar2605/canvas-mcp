import type { CanvasClient } from "./client.js";
import { listAssignments } from "./assignments.js";
import type { CourseInfo } from "./courses.js";
import type { Enrollment } from "./types.js";

export interface CourseGrade {
  courseSlug: string;
  courseId: number;
  courseName: string;
  currentScore: number | null;
  currentGrade: string | null;
  finalScore: number | null;
  /**
   * Computed from graded assignments (sum score / sum points_possible * 100)
   * when `currentScore` is null — confirmed live, RU hides course totals from
   * students (`grades.current_score` is null for every enrollment, even with
   * `include[]=total_scores`). null when no assignment has a score yet.
   */
  fallbackPercent?: number | null;
  /** Number of assignments with a non-null score, used to compute `fallbackPercent`. */
  gradedCount?: number;
  /** Total assignments in the course (graded or not). */
  totalCount?: number;
}

/** Sums score/points_possible over graded assignments to approximate a course total when Canvas hides it. */
async function computeFallback(
  client: CanvasClient,
  course: CourseInfo,
): Promise<{ fallbackPercent: number | null; gradedCount: number; totalCount: number }> {
  const assignments = await listAssignments(client, course, "all");
  let earned = 0;
  let possible = 0;
  let gradedCount = 0;
  for (const a of assignments) {
    if (a.score != null && a.pointsPossible != null) {
      earned += a.score;
      possible += a.pointsPossible;
      gradedCount++;
    }
  }
  const fallbackPercent = possible > 0 ? (earned / possible) * 100 : null;
  return { fallbackPercent, gradedCount, totalCount: assignments.length };
}

/**
 * Current grades for the given courses via a single call to
 * `/api/v1/users/self/enrollments?state[]=active&state[]=completed&include[]=grades`.
 * Canvas's real `type` value for a student enrollment is the string
 * "StudentEnrollment" (the `Enrollment.type` comment in canvas/types.ts says
 * lowercase "student", which looks stale/wrong against the live API — flagged,
 * not fixed, since types.ts is foundation). Only StudentEnrollment rows for
 * courses present in `courses` are returned, in `courses`' given order.
 */
export async function getGrades(client: CanvasClient, courses: CourseInfo[]): Promise<CourseGrade[]> {
  if (courses.length === 0) return [];

  const enrollments = await client.getAll<Enrollment>("/api/v1/users/self/enrollments", {
    state: ["active", "completed"],
    include: ["grades"],
  });

  const studentEnrollmentByCourseId = new Map<number, Enrollment>();
  for (const e of enrollments) {
    if (e.type === "StudentEnrollment") {
      studentEnrollmentByCourseId.set(e.course_id, e);
    }
  }

  const results: CourseGrade[] = [];
  for (const course of courses) {
    const enrollment = studentEnrollmentByCourseId.get(course.id);
    if (!enrollment) continue;
    const currentScore = enrollment.grades?.current_score ?? null;
    const base: CourseGrade = {
      courseSlug: course.slug,
      courseId: course.id,
      courseName: course.name,
      currentScore,
      currentGrade: enrollment.grades?.current_grade ?? null,
      finalScore: enrollment.grades?.final_score ?? null,
    };
    results.push(currentScore === null ? { ...base, ...(await computeFallback(client, course)) } : base);
  }
  return results;
}
