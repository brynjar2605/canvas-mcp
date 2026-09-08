import type { CanvasClient } from "./client.js";
import type { CourseInfo } from "./courses.js";
import type { Enrollment } from "./types.js";

export interface CourseGrade {
  courseSlug: string;
  courseId: number;
  courseName: string;
  currentScore: number | null;
  currentGrade: string | null;
  finalScore: number | null;
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
    results.push({
      courseSlug: course.slug,
      courseId: course.id,
      courseName: course.name,
      currentScore: enrollment.grades?.current_score ?? null,
      currentGrade: enrollment.grades?.current_grade ?? null,
      finalScore: enrollment.grades?.final_score ?? null,
    });
  }
  return results;
}
