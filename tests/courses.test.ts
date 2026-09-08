import { describe, expect, it } from "vitest";
import { CanvasClient } from "../src/canvas/client.js";
import { currentCourses, listCourses, resolveCourse, semesterFromTerm, slugFromCode } from "../src/canvas/courses.js";

describe("slugFromCode", () => {
  it("lowercases last segment of a real code", () => {
    expect(slugFromCode("T-603-THYD")).toBe("thyd");
    expect(slugFromCode("X-204-STOF")).toBe("stof");
    expect(slugFromCode("T-117-STR1")).toBe("str1");
  });
  it("rejects non-course shells", () => {
    expect(slugFromCode("RU-ANNOUNCE")).toBeNull();
    expect(slugFromCode("TVIUND")).toBeNull();
    expect(slugFromCode("TD- Myndbönd T-117-STR1")).toBeNull();
    expect(slugFromCode("Myndbönd: DCS-T-419-STR2")).toBeNull();
    expect(slugFromCode(undefined)).toBeNull();
  });
});

describe("semesterFromTerm", () => {
  it("derives önn from term relative to Haustönn 2024", () => {
    expect(semesterFromTerm("Haustönn 2024", "Haustönn 2024")).toBe(1);
    expect(semesterFromTerm("Vorönn 2025", "Haustönn 2024")).toBe(2);
    expect(semesterFromTerm("Haustönn 2025", "Haustönn 2024")).toBe(3);
    expect(semesterFromTerm("Vorönn 2026", "Haustönn 2024")).toBe(4);
    expect(semesterFromTerm("Haustönn 2026", "Haustönn 2024")).toBe(5);
  });
  it("returns null for Default term / before first term", () => {
    expect(semesterFromTerm("Default term", "Haustönn 2024")).toBeNull();
    expect(semesterFromTerm("Vorönn 2024", "Haustönn 2024")).toBeNull();
    expect(semesterFromTerm(null, "Haustönn 2024")).toBeNull();
  });
});

const FIXTURE = [
  { id: 2440, name: "RU Announcements", course_code: "RU-ANNOUNCE", workflow_state: "available", term: { id: 1, name: "Default term" } },
  { id: 9413, name: "Stærðfræðigreining", course_code: "T-304-CACS", workflow_state: "available", term: { id: 2, name: "Haustönn 2025" } },
  { id: 10495, name: "Þýðendur", course_code: "T-603-THYD", workflow_state: "available", term: { id: 3, name: "Haustönn 2026" } },
  { id: 10483, name: "Tölvusamskipti", course_code: "T-409-TSAM", workflow_state: "available", term: { id: 3, name: "Haustönn 2026" } },
  { id: 8455, name: "Strjál stærðfræði", course_code: "T-117-STR1", workflow_state: "completed", term: { id: 4, name: "Haustönn 2024" } },
];

const seenUrls: string[] = [];
function fakeClient(): CanvasClient {
  const fetchImpl: typeof fetch = async (input) => {
    seenUrls.push(String(input instanceof Request ? input.url : input));
    return new Response(JSON.stringify(FIXTURE), { status: 200, headers: { "content-type": "application/json" } });
  };
  return new CanvasClient(
    { baseUrl: "https://x.test", token: "t", schoolRoot: "/tmp", currentSemester: 5 },
    { fetchImpl, sleep: async () => {} },
  );
}

describe("listCourses / currentCourses / resolveCourse", () => {
  it("filters junk and sorts newest semester first", async () => {
    process.env.FIRST_TERM = "Haustönn 2024";
    const cs = await listCourses(fakeClient());
    const url = decodeURIComponent(seenUrls.at(-1)!);
    expect(url).toContain("include[]=term");
    expect(url).toContain("state[]=available");
    expect(url).not.toContain("[][]");
    expect(cs.map((c) => c.slug)).toEqual(["thyd", "tsam", "cacs", "str1"]);
    expect(cs[0]!.semester).toBe(5);
  });
  it("currentCourses = highest semester only (stale active courses excluded)", async () => {
    const cs = await currentCourses(fakeClient());
    expect(cs.map((c) => c.slug).sort()).toEqual(["thyd", "tsam"]);
  });
  it("resolves by id, slug, code, case-insensitively", async () => {
    const c = fakeClient();
    expect((await resolveCourse(c, 10495)).slug).toBe("thyd");
    expect((await resolveCourse(c, "THYD")).id).toBe(10495);
    expect((await resolveCourse(c, "t-409-tsam")).id).toBe(10483);
    await expect(resolveCourse(c, "nope")).rejects.toThrow(/No course matches "nope"/);
  });
});
