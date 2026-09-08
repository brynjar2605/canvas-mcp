import { describe, expect, it } from "vitest";
import { CanvasClient } from "../src/canvas/client.js";
import { getPage, listPages } from "../src/canvas/pages.js";

function fakeConfig() {
  return { baseUrl: "https://x.test", token: "t", schoolRoot: "/tmp", currentSemester: 5 };
}

function clientRespondingWith(status: number, body: unknown): CanvasClient {
  const fetchImpl: typeof fetch = async () =>
    typeof body === "string"
      ? new Response(body, { status })
      : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });
}

describe("listPages", () => {
  it("maps Canvas pages to PageSummary[]", async () => {
    const raw = [
      { url: "syllabus", title: "Syllabus", updated_at: "2026-01-01T00:00:00Z", front_page: true },
      { url: "week-1", title: "Week 1", front_page: false },
    ];
    const client = clientRespondingWith(200, raw);
    const pages = await listPages(client, 1);
    expect(pages).toEqual([
      { url: "syllabus", title: "Syllabus", updatedAt: "2026-01-01T00:00:00Z", frontPage: true },
      { url: "week-1", title: "Week 1", updatedAt: null, frontPage: false },
    ]);
  });

  it("returns [] when Pages is disabled for the course (403)", async () => {
    const client = clientRespondingWith(403, "forbidden");
    expect(await listPages(client, 1)).toEqual([]);
  });

  it("returns [] on 404", async () => {
    const client = clientRespondingWith(404, "not found");
    expect(await listPages(client, 1)).toEqual([]);
  });
});

describe("getPage", () => {
  it("returns title/url/bodyHtml/bodyMarkdown/updatedAt", async () => {
    const raw = {
      url: "syllabus",
      title: "Syllabus",
      body: "<h1>Hi</h1><script>bad()</script>",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const client = clientRespondingWith(200, raw);
    const page = await getPage(client, 1, "syllabus");
    expect(page.title).toBe("Syllabus");
    expect(page.url).toBe("syllabus");
    expect(page.bodyHtml).toContain("<h1>Hi</h1>");
    expect(page.bodyMarkdown).toContain("# Hi");
    expect(page.bodyMarkdown).not.toContain("bad()");
    expect(page.updatedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("throws a clear error when the page is missing / Pages is disabled (404)", async () => {
    const client = clientRespondingWith(404, "not found");
    await expect(getPage(client, 1, "nope")).rejects.toThrow(/not found/i);
  });

  it("treats a 403 the same as not-found", async () => {
    const client = clientRespondingWith(403, "forbidden");
    await expect(getPage(client, 1, "nope")).rejects.toThrow(/not found/i);
  });

  it("rejects a page url containing a path separator instead of hitting an arbitrary endpoint", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(typeof input === "string" ? input : input.toString());
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    await expect(getPage(client, 1, "../../users/self")).rejects.toThrow(/invalid page url/i);
    expect(calls).toEqual([]);
  });

  it("rejects a page url containing '..' even without a slash", async () => {
    const fetchImpl: typeof fetch = async () => new Response("{}", { status: 200 });
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });
    await expect(getPage(client, 1, "..")).rejects.toThrow(/invalid page url/i);
  });

  it("percent-encodes an otherwise-safe url before requesting it", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(typeof input === "string" ? input : input.toString());
      return new Response(JSON.stringify({ url: "week 1", title: "Week 1", body: "<p>hi</p>" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    await getPage(client, 1, "week 1");
    expect(calls[0]).toContain("/pages/week%201");
  });
});
