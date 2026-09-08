import { describe, expect, it } from "vitest";
import { CanvasClient } from "../src/canvas/client.js";
import { formatScoreWithGrade, getAssignment, isInClassOnly, listAssignments } from "../src/canvas/assignments.js";
import type { CourseInfo } from "../src/canvas/courses.js";

const course: CourseInfo = {
  id: 100,
  code: "T-603-THYD",
  slug: "thyd",
  name: "Þýðendur",
  term: "Haustönn 2026",
  semester: 5,
};

function clientReturning(data: unknown): CanvasClient {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
  return new CanvasClient(
    { baseUrl: "https://x.test", token: "t", schoolRoot: "/tmp", currentSemester: 5 },
    { fetchImpl, sleep: async () => {} },
  );
}

// "Today" per the environment is 2026-09-08.
const fixture = [
  {
    id: 1,
    name: "Past graded",
    due_at: "2026-09-01T23:59:00Z",
    points_possible: 10,
    html_url: "https://x.test/1",
    submission: { workflow_state: "graded", score: 8, grade: "B", submitted_at: "2026-08-30T00:00:00Z" },
  },
  {
    id: 2,
    name: "Past missing",
    due_at: "2026-09-05T23:59:00Z",
    points_possible: 10,
    html_url: "https://x.test/2",
    submission: { workflow_state: "unsubmitted", missing: true },
  },
  {
    id: 3,
    name: "Upcoming",
    due_at: "2026-09-15T23:59:00Z",
    points_possible: 5,
    html_url: "https://x.test/3",
    submission: { workflow_state: "unsubmitted" },
  },
  {
    id: 4,
    name: "No due date",
    due_at: null,
    points_possible: null,
    html_url: "https://x.test/4",
  },
  {
    id: 6,
    name: "Far future",
    due_at: "2026-10-25T00:00:00Z",
    points_possible: 5,
    html_url: "https://x.test/6",
  },
];

describe("listAssignments filters", () => {
  it("'all' returns everything sorted by due date, null-due last", async () => {
    const result = await listAssignments(clientReturning(fixture), course, "all");
    expect(result.map((a) => a.id)).toEqual([1, 2, 3, 6, 4]);
  });

  it("'upcoming' excludes past and null-due, respects the days window (default 30)", async () => {
    const result = await listAssignments(clientReturning(fixture), course, "upcoming", 30);
    expect(result.map((a) => a.id)).toEqual([3]);
  });

  it("'upcoming' with a wider window includes items further out", async () => {
    const result = await listAssignments(clientReturning(fixture), course, "upcoming", 60);
    expect(result.map((a) => a.id)).toEqual([3, 6]);
  });

  it("'missing' honors submission.missing", async () => {
    const result = await listAssignments(clientReturning(fixture), course, "missing");
    expect(result.map((a) => a.id)).toEqual([2]);
  });

  it("'graded' = submission.score != null", async () => {
    const result = await listAssignments(clientReturning(fixture), course, "graded");
    expect(result.map((a) => a.id)).toEqual([1]);
  });

  it("'past' with no days returns all past (null-due excluded)", async () => {
    const result = await listAssignments(clientReturning(fixture), course, "past");
    expect(result.map((a) => a.id)).toEqual([1, 2]);
  });

  it("'past' with a days window excludes older-than-window items", async () => {
    const result = await listAssignments(clientReturning(fixture), course, "past", 5);
    expect(result.map((a) => a.id)).toEqual([2]);
  });

  it("never infers 'missing' from due date + no submission — only Canvas's own submission.missing counts", async () => {
    const overdueNoSubmission = [
      { id: 5, name: "Overdue, never submitted", due_at: "2026-01-01T00:00:00Z", points_possible: 10, html_url: "https://x.test/5" },
    ];
    const result = await listAssignments(clientReturning(overdueNoSubmission), course, "missing");
    expect(result.map((a) => a.id)).toEqual([]);
    const all = await listAssignments(clientReturning(overdueNoSubmission), course, "all");
    expect(all[0]!.missing).toBe(false);
  });

  it("on-paper/none assignments are submitted (and not missing) once graded, even with submitted_at null", async () => {
    const onPaper = [
      {
        id: 8,
        name: "In-class quiz",
        due_at: "2026-09-01T00:00:00Z",
        points_possible: 2,
        html_url: "https://x.test/8",
        submission_types: ["on_paper"],
        submission: { workflow_state: "graded", score: 2, submitted_at: null },
      },
    ];
    const result = await listAssignments(clientReturning(onPaper), course, "all");
    expect(result[0]!.submitted).toBe(true);
    expect(result[0]!.missing).toBe(false);
  });

  it("does not mark a future assignment as missing even with no submission", async () => {
    const future = [
      { id: 7, name: "Future, no submission yet", due_at: "2026-12-01T00:00:00Z", points_possible: 10, html_url: "https://x.test/7" },
    ];
    const result = await listAssignments(clientReturning(future), course, "all");
    expect(result[0]!.missing).toBe(false);
  });
});

describe("getAssignment", () => {
  it("converts description to markdown, maps rubric, and extracts /files/ attachments", async () => {
    const raw = {
      id: 42,
      name: "Essay",
      due_at: "2026-09-20T23:59:00Z",
      points_possible: 20,
      html_url: "https://x.test/42",
      description:
        '<p>Read <a href="https://x.test/courses/1/files/999/download">handout.pdf</a> and <a href="https://x.test/courses/1/pages/syllabus">the syllabus</a>.</p>',
      submission_types: ["online_upload"],
      rubric: [
        { description: "Clarity", points: 5 },
        { long_description: "Structure", points: 15 },
      ],
      unlock_at: "2026-09-10T00:00:00Z",
      lock_at: "2026-09-21T00:00:00Z",
      submission: { workflow_state: "unsubmitted" },
    };

    const detail = await getAssignment(clientReturning(raw), course, 42);

    expect(detail.descriptionMarkdown).toContain("[handout.pdf](https://x.test/courses/1/files/999/download)");
    expect(detail.rubric).toEqual([
      { description: "Clarity", points: 5 },
      { description: "Structure", points: 15 },
    ]);
    expect(detail.attachments).toEqual([
      { name: "handout.pdf", url: "https://x.test/courses/1/files/999/download", fileId: 999 },
    ]);
    expect(detail.unlockAt).toBe("2026-09-10T00:00:00Z");
    expect(detail.lockAt).toBe("2026-09-21T00:00:00Z");
    expect(detail.submissionTypes).toEqual(["online_upload"]);
    expect(detail.courseSlug).toBe("thyd");
  });

  it("decodes HTML entities and strips the verifier param from attachment hrefs (real Canvas shape)", async () => {
    const raw = {
      id: 44,
      name: "Handout",
      due_at: null,
      points_possible: null,
      html_url: "https://x.test/44",
      description:
        '<p><a href="https://x.test/files/2712565/download?verifier=abc123&amp;wrap=1">Skjal &amp; gögn.pdf</a></p>',
    };
    const detail = await getAssignment(clientReturning(raw), course, 44);
    expect(detail.attachments).toEqual([
      {
        name: "Skjal & gögn.pdf",
        url: "https://x.test/files/2712565/download?wrap=1",
        fileId: 2712565,
      },
    ]);
  });

  it("returns an empty rubric/attachments array when the assignment has none", async () => {
    const raw = {
      id: 43,
      name: "Quiz",
      due_at: null,
      points_possible: null,
      html_url: "https://x.test/43",
      description: null,
    };
    const detail = await getAssignment(clientReturning(raw), course, 43);
    expect(detail.rubric).toEqual([]);
    expect(detail.attachments).toEqual([]);
    expect(detail.descriptionMarkdown).toBe("");
  });

  it("strips verifier params from every URL in the description markdown, not just parsed attachments", async () => {
    const raw = {
      id: 45,
      name: "Reading",
      due_at: null,
      points_possible: null,
      html_url: "https://x.test/45",
      description:
        '<p>See <a href="https://x.test/files/1/download?verifier=abc&amp;wrap=1">one</a> and ' +
        '<a href="https://x.test/files/2/download?verifier=def">two</a>.</p>',
    };
    const detail = await getAssignment(clientReturning(raw), course, 45);
    expect(detail.descriptionMarkdown).not.toContain("verifier");
    expect(detail.descriptionMarkdown).toContain("[one](https://x.test/files/1/download?wrap=1)");
    expect(detail.descriptionMarkdown).toContain("[two](https://x.test/files/2/download)");
  });
});

describe("isInClassOnly", () => {
  it("is true only when every submission type is 'none' or 'on_paper'", () => {
    expect(isInClassOnly(["on_paper"])).toBe(true);
    expect(isInClassOnly(["none"])).toBe(true);
    expect(isInClassOnly(["none", "on_paper"])).toBe(true);
    expect(isInClassOnly(["online_upload"])).toBe(false);
    expect(isInClassOnly(["none", "online_upload"])).toBe(false);
    expect(isInClassOnly([])).toBe(false);
    expect(isInClassOnly(undefined)).toBe(false);
  });
});

describe("formatScoreWithGrade", () => {
  it("drops the grade when it's just the bare score restated (the observed 'Score: 2/2 (2)' bug)", () => {
    expect(formatScoreWithGrade(2, 2, "2")).toBe("2/2");
  });

  it("drops the grade when it equals the full score/possible text", () => {
    expect(formatScoreWithGrade(8, 10, "8/10")).toBe("8/10");
  });

  it("keeps a grade that adds information (letter grade, percentage, ...)", () => {
    expect(formatScoreWithGrade(8, 10, "B")).toBe("8/10 (B)");
    expect(formatScoreWithGrade(9, 10, "90%")).toBe("9/10 (90%)");
  });

  it("renders just the score when pointsPossible or grade is null", () => {
    expect(formatScoreWithGrade(5, null, null)).toBe("5");
  });
});
