import { describe, expect, it, vi } from "vitest";
import { CanvasClient, type FetchImpl } from "../src/canvas/client.js";
import { listAnnouncements } from "../src/canvas/announcements.js";
import type { CourseInfo } from "../src/canvas/courses.js";

const courses: CourseInfo[] = [
  { id: 1, code: "T-603-THYD", slug: "thyd", name: "Þýðendur", term: "Haustönn 2026", semester: 5 },
];

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

function fakeConfig() {
  return { baseUrl: "https://x.test", token: "t", schoolRoot: "/tmp", currentSemester: 5 };
}

describe("listAnnouncements", () => {
  it("sends start_date and end_date explicitly, and context_codes[] for the courses", async () => {
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValue(jsonResponse([]));
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    await listAnnouncements(client, courses, 30);

    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.pathname).toBe("/api/v1/announcements");
    expect(url.searchParams.get("start_date")).toBeTruthy();
    expect(url.searchParams.get("end_date")).toBeTruthy();
    expect(url.searchParams.getAll("context_codes[]")).toEqual(["course_1"]);
  });

  it("maps announcements to AnnouncementSummary and sorts newest first", async () => {
    const raw = [
      { id: 1, title: "Old", message: "<p>old</p>", posted_at: "2026-08-01T00:00:00Z", context_code: "course_1", html_url: "https://x.test/1" },
      { id: 2, title: "New", message: "<p>new</p>", posted_at: "2026-09-05T00:00:00Z", context_code: "course_1", html_url: "https://x.test/2" },
    ];
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValue(jsonResponse(raw));
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const result = await listAnnouncements(client, courses, 30);

    expect(result.map((a) => a.title)).toEqual(["New", "Old"]);
    expect(result[0]).toMatchObject({ courseSlug: "thyd", courseId: 1, bodyMarkdown: "new" });
  });

  it("strips the verifier query param from links in the body", async () => {
    const raw = [
      {
        id: 4,
        title: "Handout",
        message: '<p>See <a href="https://x.test/files/1/download?verifier=abc&amp;wrap=1">handout</a></p>',
        posted_at: "2026-09-01T00:00:00Z",
        context_code: "course_1",
        html_url: "https://x.test/4",
      },
    ];
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValue(jsonResponse(raw));
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const result = await listAnnouncements(client, courses, 30);
    expect(result[0]!.bodyMarkdown).not.toContain("verifier");
    expect(result[0]!.bodyMarkdown).toContain("(https://x.test/files/1/download?wrap=1)");
  });

  it("skips announcements whose context_code doesn't match a known course", async () => {
    const raw = [
      { id: 3, title: "Unknown course", message: null, posted_at: "2026-09-01T00:00:00Z", context_code: "course_999", html_url: "https://x.test/3" },
    ];
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValue(jsonResponse(raw));
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    expect(await listAnnouncements(client, courses, 30)).toEqual([]);
  });

  it("returns [] without calling fetch when there are no courses", async () => {
    const fetchImpl = vi.fn<FetchImpl>();
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });
    expect(await listAnnouncements(client, [], 30)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
