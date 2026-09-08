import { describe, expect, it, vi } from "vitest";
import { CanvasClient, type FetchImpl } from "../src/canvas/client.js";
import { getGrades } from "../src/canvas/grades.js";
import type { CourseInfo } from "../src/canvas/courses.js";

const courses: CourseInfo[] = [
  { id: 1, code: "T-603-THYD", slug: "thyd", name: "Þýðendur", term: "Haustönn 2026", semester: 5 },
  { id: 2, code: "T-409-TSAM", slug: "tsam", name: "Tölvusamskipti", term: "Haustönn 2026", semester: 5 },
];

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

function fakeConfig() {
  return { baseUrl: "https://x.test", token: "t", schoolRoot: "/tmp", currentSemester: 5 };
}

describe("getGrades", () => {
  it("filters to StudentEnrollment and to the given courses, returned in course order", async () => {
    const raw = [
      { course_id: 1, type: "TeacherEnrollment", grades: { current_score: 100 } },
      { course_id: 2, type: "StudentEnrollment", grades: { current_score: 90, current_grade: "A", final_score: 88 } },
      { course_id: 1, type: "StudentEnrollment", grades: { current_score: 75, current_grade: "C", final_score: null } },
      { course_id: 999, type: "StudentEnrollment", grades: { current_score: 50 } },
    ];
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValue(jsonResponse(raw));
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const grades = await getGrades(client, courses);

    expect(grades).toEqual([
      { courseSlug: "thyd", courseId: 1, courseName: "Þýðendur", currentScore: 75, currentGrade: "C", finalScore: null },
      { courseSlug: "tsam", courseId: 2, courseName: "Tölvusamskipti", currentScore: 90, currentGrade: "A", finalScore: 88 },
    ]);
  });

  it("calls enrollments with state[]=active,completed and include[]=grades", async () => {
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValue(jsonResponse([]));
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    await getGrades(client, courses);

    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.pathname).toBe("/api/v1/users/self/enrollments");
    expect(url.searchParams.getAll("state[]")).toEqual(["active", "completed"]);
    expect(url.searchParams.getAll("include[]")).toEqual(["grades"]);
  });

  it("omits a course with no matching StudentEnrollment", async () => {
    const raw = [{ course_id: 1, type: "StudentEnrollment", grades: { current_score: 75 } }];
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValue(jsonResponse(raw));
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const grades = await getGrades(client, courses);
    expect(grades.map((g) => g.courseSlug)).toEqual(["thyd"]);
  });

  it("returns [] without calling fetch when there are no courses", async () => {
    const fetchImpl = vi.fn<FetchImpl>();
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });
    expect(await getGrades(client, [])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("computes a fallbackPercent from graded assignments when Canvas hides current_score (RU behavior)", async () => {
    const enrollments = [
      { course_id: 1, type: "StudentEnrollment", grades: { current_score: null, current_grade: null, final_score: null } },
    ];
    const assignments = [
      { id: 1, name: "HW1", html_url: "https://x.test/1", points_possible: 2, submission: { score: 2 } },
      { id: 2, name: "HW2", html_url: "https://x.test/2", points_possible: 10, submission: { score: 8 } },
      { id: 3, name: "HW3 (ungraded)", html_url: "https://x.test/3", points_possible: 10 },
    ];
    const fetchImpl = vi.fn<FetchImpl>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/users/self/enrollments") return jsonResponse(enrollments);
      if (url.pathname === "/api/v1/courses/1/assignments") return jsonResponse(assignments);
      throw new Error(`unexpected path: ${url.pathname}`);
    });
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const grades = await getGrades(client, [courses[0]!]);

    expect(grades).toHaveLength(1);
    expect(grades[0]!.currentScore).toBeNull();
    expect(grades[0]!.gradedCount).toBe(2);
    expect(grades[0]!.totalCount).toBe(3);
    expect(grades[0]!.fallbackPercent).toBeCloseTo((10 / 12) * 100, 1); // 83.3%
  });

  it("does not compute a fallback (or call the assignments endpoint) when current_score is present", async () => {
    const enrollments = [{ course_id: 1, type: "StudentEnrollment", grades: { current_score: 75 } }];
    const fetchImpl = vi.fn<FetchImpl>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/users/self/enrollments") return jsonResponse(enrollments);
      throw new Error(`unexpected path: ${url.pathname}`);
    });
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const grades = await getGrades(client, [courses[0]!]);
    expect(grades[0]!.fallbackPercent).toBeUndefined();
    expect(grades[0]!.gradedCount).toBeUndefined();
  });
});
