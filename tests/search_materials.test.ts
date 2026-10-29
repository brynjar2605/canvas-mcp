import { describe, expect, it } from "vitest";
import { CanvasClient, type FetchImpl } from "../src/canvas/client.js";
import type { Config } from "../src/config.js";
import { tool } from "../src/tools/search_materials.js";

function fakeConfig(): Config {
  return { baseUrl: "https://x.test", token: "t", schoolRoot: "/tmp", currentSemester: 5 };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

const COURSES = [
  {
    id: 1,
    course_code: "T-603-THYD",
    name: "Þýðendur",
    term: { name: "Haustönn 2026" },
    workflow_state: "available",
  },
];

describe("search_materials tool", () => {
  it("appends a note when a course's Files tab is hidden and results come from discovery", async () => {
    const fetchImpl: FetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/courses") return jsonResponse(COURSES);
      if (url.pathname === "/api/v1/courses/1/files") return new Response("forbidden", { status: 403 });
      if (url.pathname === "/api/v1/courses/1/folders") return jsonResponse([]);
      if (url.pathname === "/api/v1/courses/1/modules") return jsonResponse([]);
      if (url.pathname === "/api/v1/courses/1/pages") return jsonResponse([]);
      if (url.pathname === "/api/v1/courses/1/assignments") return jsonResponse([]);
      throw new Error(`unexpected path: ${url.pathname}`);
    };
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const result = await tool.handler(
      { query: "syllabus", course: "thyd" },
      { client, config: fakeConfig() },
    );

    expect(result).toMatch(/No file, module item or page in thyd has a name matching "syllabus"/);
    expect(result).toMatch(/thyd hides the Files tab/);
  });

  it("matches a file by its folder name even when the filename alone doesn't say it", async () => {
    const folders = [
      { id: 1, name: "course files", full_name: "course files", parent_folder_id: null, files_count: 1, folders_count: 1 },
      { id: 2, name: "Slides", full_name: "course files/Slides", parent_folder_id: 1, files_count: 1, folders_count: 0 },
    ];
    const files = [
      {
        id: 555,
        display_name: "T-603-THYD-LexicalAnalysis.pdf",
        filename: "T-603-THYD-LexicalAnalysis.pdf",
        folder_id: 2,
        size: 1000,
        "content-type": "application/pdf",
        url: "https://x.test/555",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ];
    const fetchImpl: FetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/courses") return jsonResponse(COURSES);
      if (url.pathname === "/api/v1/courses/1/files") return jsonResponse(files);
      if (url.pathname === "/api/v1/courses/1/folders") return jsonResponse(folders);
      if (url.pathname === "/api/v1/courses/1/modules") return jsonResponse([]);
      if (url.pathname === "/api/v1/courses/1/pages") return jsonResponse([]);
      throw new Error(`unexpected path: ${url.pathname}`);
    };
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const result = await tool.handler(
      { query: "lexing slides", course: "thyd" },
      { client, config: fakeConfig() },
    );

    expect(result).toContain("T-603-THYD-LexicalAnalysis.pdf");
    expect(result).toContain("file_id 555");
  });

  it("matches a module item by its subheader and module name", async () => {
    const modules = [
      {
        id: 10,
        name: "Week 3",
        position: 1,
        items: [
          { id: 100, title: "Slides", type: "SubHeader" },
          { id: 101, title: "Lecture 1", type: "File", content_id: 900 },
        ],
      },
    ];
    const fetchImpl: FetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/courses") return jsonResponse(COURSES);
      if (url.pathname === "/api/v1/courses/1/files") return new Response("forbidden", { status: 403 });
      if (url.pathname === "/api/v1/courses/1/folders") return jsonResponse([]);
      if (url.pathname === "/api/v1/courses/1/modules") return jsonResponse(modules);
      if (url.pathname === "/api/v1/courses/1/pages") return jsonResponse([]);
      if (url.pathname === "/api/v1/courses/1/assignments") return jsonResponse([]);
      throw new Error(`unexpected path: ${url.pathname}`);
    };
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const result = await tool.handler(
      { query: "slides", course: "thyd" },
      { client, config: fakeConfig() },
    );

    expect(result).toContain("Lecture 1");
    // The SubHeader item itself ("Slides") must never appear as its own result line.
    expect(result).not.toMatch(/module: "Week 3" › Slides\b/);
  });

  it("merges a file that also appears as a module item into one line, with module context appended", async () => {
    const files = [
      {
        id: 9001,
        display_name: "YB_Chapter_03_LexicalAnalysis.pdf",
        filename: "YB_Chapter_03_LexicalAnalysis.pdf",
        folder_id: null,
        size: 106496,
        "content-type": "application/pdf",
        url: "https://x.test/9001",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ];
    const modules = [
      {
        id: 20,
        name: "Front End",
        position: 1,
        items: [
          { id: 200, title: "Slides", type: "SubHeader" },
          { id: 201, title: "Chapter 3: Lexical Analysis", type: "File", content_id: 9001 },
        ],
      },
    ];
    const fetchImpl: FetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/courses") return jsonResponse(COURSES);
      if (url.pathname === "/api/v1/courses/1/files") return jsonResponse(files);
      if (url.pathname === "/api/v1/courses/1/folders") return jsonResponse([]);
      if (url.pathname === "/api/v1/courses/1/modules") return jsonResponse(modules);
      if (url.pathname === "/api/v1/courses/1/pages") return jsonResponse([]);
      throw new Error(`unexpected path: ${url.pathname}`);
    };
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const result = await tool.handler(
      { query: "lexical analysis", course: "thyd" },
      { client, config: fakeConfig() },
    );

    const fileIdOccurrences = (result.match(/file_id 9001/g) ?? []).length;
    expect(fileIdOccurrences).toBe(1);
    expect(result).toContain("YB_Chapter_03_LexicalAnalysis.pdf");
    expect(result).toContain('in module "Front End" › Chapter 3: Lexical Analysis');
    expect(result).not.toContain("module: \"Front End\" › Chapter 3: Lexical Analysis (file_id=9001)");
  });

  it("merges a page that also appears as a module item into one line, with module context appended", async () => {
    const pages = [{ url: "week-3-overview", title: "Week 3 Overview", updated_at: "2026-01-01T00:00:00Z" }];
    const modules = [
      {
        id: 21,
        name: "Week 3",
        position: 1,
        items: [{ id: 210, title: "Overview", type: "Page", page_url: "week-3-overview" }],
      },
    ];
    const fetchImpl: FetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/courses") return jsonResponse(COURSES);
      if (url.pathname === "/api/v1/courses/1/files") return new Response("forbidden", { status: 403 });
      if (url.pathname === "/api/v1/courses/1/folders") return jsonResponse([]);
      if (url.pathname === "/api/v1/courses/1/modules") return jsonResponse(modules);
      if (url.pathname === "/api/v1/courses/1/pages") return jsonResponse(pages);
      if (url.pathname === "/api/v1/courses/1/assignments") return jsonResponse([]);
      throw new Error(`unexpected path: ${url.pathname}`);
    };
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const result = await tool.handler(
      { query: "week 3 overview", course: "thyd" },
      { client, config: fakeConfig() },
    );

    const pageOccurrences = (result.match(/page_url=week-3-overview/g) ?? []).length;
    expect(pageOccurrences).toBe(1);
    expect(result).toContain('in module "Week 3" › Overview');
  });

  it("keeps an ExternalUrl module item as its own link: result", async () => {
    const modules = [
      {
        id: 22,
        name: "Resources",
        position: 1,
        items: [
          {
            id: 220,
            title: "Course Syllabus PDF",
            type: "ExternalUrl",
            external_url: "https://example.com/syllabus.pdf",
          },
        ],
      },
    ];
    const fetchImpl: FetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/courses") return jsonResponse(COURSES);
      if (url.pathname === "/api/v1/courses/1/files") return new Response("forbidden", { status: 403 });
      if (url.pathname === "/api/v1/courses/1/folders") return jsonResponse([]);
      if (url.pathname === "/api/v1/courses/1/modules") return jsonResponse(modules);
      if (url.pathname === "/api/v1/courses/1/pages") return jsonResponse([]);
      if (url.pathname === "/api/v1/courses/1/assignments") return jsonResponse([]);
      throw new Error(`unexpected path: ${url.pathname}`);
    };
    const client = new CanvasClient(fakeConfig(), { fetchImpl, sleep: async () => {} });

    const result = await tool.handler(
      { query: "syllabus", course: "thyd" },
      { client, config: fakeConfig() },
    );

    expect(result).toContain("link: Course Syllabus PDF (https://example.com/syllabus.pdf)");
  });
});
