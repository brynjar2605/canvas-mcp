import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasClient } from "../src/canvas/client.js";
import {
  currentCourses,
  currentSemesterOf,
  listCourses,
  resolveCourse,
  semesterFromTerm,
  slugFromCode,
  type CourseInfo,
} from "../src/canvas/courses.js";

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

// RU term windows as Canvas reports them via include[]=term.
const H2024 = { start_at: "2024-08-01T00:00:00Z", end_at: "2025-01-15T00:00:00Z" };
const H2025 = { start_at: "2025-08-01T00:00:00Z", end_at: "2026-01-15T00:00:00Z" };
const H2026 = { start_at: "2026-08-01T00:00:00Z", end_at: "2027-01-15T00:00:00Z" };
const V2027 = { start_at: "2027-01-01T00:00:00Z", end_at: "2027-06-30T00:00:00Z" };

const FIXTURE = [
  { id: 1008, name: "RU Announcements", course_code: "RU-ANNOUNCE", workflow_state: "available", term: { id: 1, name: "Default term", start_at: null, end_at: null } },
  { id: 1006, name: "Stærðfræðigreining", course_code: "T-304-CACS", workflow_state: "available", term: { id: 2, name: "Haustönn 2025", ...H2025 } },
  { id: 1005, name: "Þýðendur", course_code: "T-603-THYD", workflow_state: "available", term: { id: 3, name: "Haustönn 2026", ...H2026 } },
  { id: 1002, name: "Tölvusamskipti", course_code: "T-409-TSAM", workflow_state: "available", term: { id: 3, name: "Haustönn 2026", ...H2026 } },
  { id: 1007, name: "Strjál stærðfræði", course_code: "T-117-STR1", workflow_state: "completed", term: { id: 4, name: "Haustönn 2024", ...H2024 } },
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
  // CourseNotFoundError picks "current" with the real clock; pin it so tests don't drift.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("filters junk and sorts newest semester first", async () => {
    process.env.FIRST_TERM = "Haustönn 2024";
    const cs = await listCourses(fakeClient());
    const url = decodeURIComponent(seenUrls.at(-1)!);
    expect(url).toContain("include[]=term");
    expect(url).toContain("state[]=available");
    expect(url).not.toContain("[][]");
    expect(cs.map((c) => c.slug)).toEqual(["thyd", "tsam", "cacs", "str1"]);
    expect(cs[0]!.semester).toBe(5);
    expect(cs[0]!.termStart).toBe("2026-08-01T00:00:00Z");
    expect(cs[0]!.termEnd).toBe("2027-01-15T00:00:00Z");
  });
  it("currentCourses = the ongoing semester only (stale active courses excluded)", async () => {
    const cs = await currentCourses(fakeClient(), new Date("2026-10-29T12:00:00Z"));
    expect(cs.map((c) => c.slug).sort()).toEqual(["thyd", "tsam"]);
  });
  it("resolves by id, slug, code, case-insensitively", async () => {
    const c = fakeClient();
    expect((await resolveCourse(c, 1005)).slug).toBe("thyd");
    expect((await resolveCourse(c, "THYD")).id).toBe(1005);
    expect((await resolveCourse(c, "t-409-tsam")).id).toBe(1002);
    await expect(resolveCourse(c, "nope")).rejects.toThrow(/No course matches "nope"/);
  });

  it("lists current-semester courses first in the not-found error", async () => {
    const c = fakeClient();
    await expect(resolveCourse(c, "nope")).rejects.toThrow(/Current courses: thyd, tsam\./);
  });

  it("resolves by a unique, case-insensitive substring of the course name (>= 4 chars)", async () => {
    const c = fakeClient();
    expect((await resolveCourse(c, "þýðendur")).slug).toBe("thyd");
    expect((await resolveCourse(c, "STRJÁL")).slug).toBe("str1");
    // Too short to trust as a name fragment — falls through to not-found.
    await expect(resolveCourse(c, "tol")).rejects.toThrow(/No course matches "tol"/);
  });

  it("does not resolve an ambiguous name substring shared by two courses", async () => {
    const ambiguous = [
      { id: 1, name: "Forritun 1", course_code: "T-101-FOR1", workflow_state: "available", term: { id: 1, name: "Haustönn 2026" } },
      { id: 2, name: "Forritun 2", course_code: "T-102-FOR2", workflow_state: "available", term: { id: 1, name: "Haustönn 2026" } },
    ];
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify(ambiguous), { status: 200, headers: { "content-type": "application/json" } });
    const client = new CanvasClient(
      { baseUrl: "https://x.test", token: "t", schoolRoot: "/tmp", currentSemester: 5 },
      { fetchImpl, sleep: async () => {} },
    );
    await expect(resolveCourse(client, "forritun")).rejects.toThrow(/No course matches "forritun"/);
  });

  it("resolves a local folder name recorded in the course mapping", async () => {
    const c = fakeClient();
    const mapping = {
      "1005": { code: "T-603-THYD", slug: "thyd", semester: 5, folder: "compilers" },
    } as unknown as Parameters<typeof resolveCourse>[2];
    expect((await resolveCourse(c, "compilers", mapping)).slug).toBe("thyd");
  });
});

function info(slug: string, term: string | null, dates: { start_at: string | null; end_at: string | null } | null): CourseInfo {
  return {
    id: slug.length,
    code: `T-000-${slug.toUpperCase()}`,
    slug,
    name: slug,
    term,
    semester: semesterFromTerm(term, "Haustönn 2024"),
    termStart: dates?.start_at ?? null,
    termEnd: dates?.end_at ?? null,
  };
}

describe("currentSemesterOf (date-based)", () => {
  const cacs = info("cacs", "Haustönn 2025", H2025); // stale, still "active" on Canvas
  const thyd = info("thyd", "Haustönn 2026", H2026);
  const tsam = info("tsam", "Haustönn 2026", H2026);
  const star = info("star", "Vorönn 2027", V2027); // enrolled ahead for next semester

  beforeEach(() => {
    process.env.FIRST_TERM = "Haustönn 2024";
  });

  it("keeps the ongoing semester when a future-semester course is present (the bug)", () => {
    expect(currentSemesterOf([cacs, thyd, tsam, star], new Date("2026-10-29T12:00:00Z"))).toBe(5);
  });

  it("excludes a stale Haustönn 2025 course that Canvas still lists as active", () => {
    expect(currentSemesterOf([cacs, thyd], new Date("2026-09-15T00:00:00Z"))).toBe(5);
  });

  it("picks the new Vorönn during the Jan 1–15 overlap", () => {
    expect(currentSemesterOf([thyd, tsam, star], new Date("2027-01-10T12:00:00Z"))).toBe(6);
  });

  it("term start is inclusive, end exclusive", () => {
    expect(currentSemesterOf([thyd, star], new Date("2027-01-01T00:00:00Z"))).toBe(6);
    // At exactly 2027-01-15 Haustönn 2026 has ended; with nothing ongoing, the last-started term wins.
    expect(currentSemesterOf([thyd], new Date("2027-01-15T00:00:00Z"))).toBe(5);
  });

  it("picks the just-ended Vorönn in July (no term in progress)", () => {
    const fall27 = info("fall", "Haustönn 2027", { start_at: "2027-08-01T00:00:00Z", end_at: "2028-01-15T00:00:00Z" });
    expect(currentSemesterOf([thyd, star, fall27], new Date("2027-07-15T00:00:00Z"))).toBe(6);
  });

  it("falls back to the calendar when terms have no dates (October → Haustönn)", () => {
    const noDates = [info("cacs", "Haustönn 2025", null), info("thyd", "Haustönn 2026", null), info("star", "Vorönn 2027", null)];
    expect(currentSemesterOf(noDates, new Date("2026-10-29T12:00:00Z"))).toBe(5);
  });

  it("falls back to the calendar when terms have no dates (March → Vorönn)", () => {
    const noDates = [info("thyd", "Haustönn 2026", null), info("star", "Vorönn 2027", null), info("fall", "Haustönn 2027", null)];
    expect(currentSemesterOf(noDates, new Date("2027-03-10T12:00:00Z"))).toBe(6);
    // March 2026 → Vorönn 2026 (önn 4): highest semester <= 4 is Haustönn 2025 (önn 3).
    expect(currentSemesterOf([info("cacs", "Haustönn 2025", null), info("thyd", "Haustönn 2026", null)], new Date("2026-03-10T00:00:00Z"))).toBe(3);
  });

  it("only future courses → the lowest semester (brand-new student)", () => {
    const fall27 = info("fall", "Haustönn 2027", { start_at: "2027-08-01T00:00:00Z", end_at: "2028-01-15T00:00:00Z" });
    expect(currentSemesterOf([star, fall27], new Date("2026-10-29T12:00:00Z"))).toBe(6);
    expect(currentSemesterOf([info("star", "Vorönn 2027", null), info("fall", "Haustönn 2027", null)], new Date("2026-10-29T12:00:00Z"))).toBe(6);
  });

  it("returns null when no course has a semester", () => {
    expect(currentSemesterOf([], new Date("2026-10-29T12:00:00Z"))).toBeNull();
    expect(currentSemesterOf([info("misc", null, null)], new Date("2026-10-29T12:00:00Z"))).toBeNull();
  });

  it("currentCourses uses the same rule (future course excluded)", async () => {
    const withFuture = [...FIXTURE, { id: 1009, name: "Stærðfræði", course_code: "T-999-STAR", workflow_state: "available", term: { id: 5, name: "Vorönn 2027", ...V2027 } }];
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify(withFuture), { status: 200, headers: { "content-type": "application/json" } });
    const client = new CanvasClient(
      { baseUrl: "https://x.test", token: "t", schoolRoot: "/tmp", currentSemester: null },
      { fetchImpl, sleep: async () => {} },
    );
    const cs = await currentCourses(client, new Date("2026-10-29T12:00:00Z"));
    expect(cs.map((c) => c.slug).sort()).toEqual(["thyd", "tsam"]);
    const jan = await currentCourses(client, new Date("2027-01-10T00:00:00Z"));
    expect(jan.map((c) => c.slug)).toEqual(["star"]);
  });
});
