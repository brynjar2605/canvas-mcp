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
});
