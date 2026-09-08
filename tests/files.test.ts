import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CanvasClient } from "../src/canvas/client.js";
import { downloadFile, listAllFiles, listAllFilesWithMeta } from "../src/canvas/files.js";
import type { CanvasFile, Folder } from "../src/canvas/types.js";

const FOLDERS: Folder[] = [
  { id: 1, name: "course files", full_name: "course files", parent_folder_id: null, files_count: 1, folders_count: 1 },
  {
    id: 2,
    name: "Vika 3",
    full_name: "course files/Fyrirlestrar/Vika 3",
    parent_folder_id: 1,
    files_count: 2,
    folders_count: 0,
  },
];

const FILES: CanvasFile[] = [
  {
    id: 101,
    display_name: "Yfirlit.pdf",
    filename: "yfirlit.pdf",
    folder_id: 1,
    size: 100,
    "content-type": "application/pdf",
    url: "https://cdn.test/101?token=old",
    updated_at: "2026-01-01T00:00:00Z",
  },
  {
    id: 102,
    display_name: "Glaerur.pdf",
    filename: "glaerur.pdf",
    folder_id: 2,
    size: 200,
    "content-type": "application/pdf",
    url: "https://cdn.test/102?token=old",
    updated_at: "2026-01-02T00:00:00Z",
  },
  {
    id: 103,
    display_name: "Locked.pdf",
    filename: "locked.pdf",
    folder_id: 2,
    size: 50,
    "content-type": "application/pdf",
    url: "https://cdn.test/103?token=old",
    updated_at: "2026-01-03T00:00:00Z",
    locked: true,
  },
];

function fakeClient(fresh: Partial<CanvasFile> = {}): { client: CanvasClient; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    calls.push(url.pathname);

    if (url.pathname === "/api/v1/courses/9/folders") {
      return jsonResponse(FOLDERS);
    }
    if (url.pathname === "/api/v1/courses/9/files") {
      return jsonResponse(FILES);
    }
    const m = url.pathname.match(/^\/api\/v1\/files\/(\d+)$/);
    if (m) {
      const base = FILES.find((f) => f.id === Number(m[1]))!;
      return jsonResponse({ ...base, url: "https://cdn.test/fresh", ...fresh });
    }
    if (url.pathname === "/fresh") {
      return new Response("file-bytes-here", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  const client = new CanvasClient(
    { baseUrl: "https://cdn.test", token: "t", schoolRoot: "/tmp", currentSemester: 5 },
    { fetchImpl, sleep: async () => {} }
  );
  return { client, calls };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

describe("listAllFiles", () => {
  it("resolves folderPath and strips the 'course files' prefix", async () => {
    const { client } = fakeClient();
    const files = await listAllFiles(client, 9);
    const byId = new Map(files.map((f) => [f.id, f]));

    expect(byId.get(101)?.folderPath).toBe("");
    expect(byId.get(102)?.folderPath).toBe("Fyrirlestrar/Vika 3");
  });

  it("includes locked files but flags them", async () => {
    const { client } = fakeClient();
    const files = await listAllFiles(client, 9);
    const locked = files.find((f) => f.id === 103);
    expect(locked?.locked).toBe(true);
    expect(files.find((f) => f.id === 101)?.locked).toBe(false);
  });

  it("maps the compact FileEntry fields", async () => {
    const { client } = fakeClient();
    const files = await listAllFiles(client, 9);
    const f = files.find((f) => f.id === 101)!;
    expect(f).toMatchObject({
      id: 101,
      name: "Yfirlit.pdf",
      size: 100,
      contentType: "application/pdf",
      updatedAt: "2026-01-01T00:00:00Z",
    });
  });
});

describe("listAllFiles — hidden Files tab discovery fallback", () => {
  const HIDDEN_FOLDERS: Folder[] = [
    { id: 1, name: "course files", full_name: "course files", parent_folder_id: null, files_count: 0, folders_count: 1 },
    { id: 2, name: "Slides", full_name: "course files/Slides", parent_folder_id: 1, files_count: 3, folders_count: 0 },
  ];

  const HIDDEN_MODULES = [
    {
      id: 10,
      name: "Week 1",
      position: 1,
      items: [
        { id: 100, title: "Slides 1", type: "File", content_id: 201 },
        { id: 101, title: "Slides 2", type: "File", content_id: 202 },
        { id: 102, title: "Week 1 page", type: "Page", page_url: "week-1" },
      ],
    },
  ];

  const HIDDEN_PAGES = [{ url: "week-1", title: "Week 1", updated_at: "2026-01-02T00:00:00Z", front_page: false }];

  const HIDDEN_PAGE_BODY = {
    url: "week-1",
    title: "Week 1",
    body: '<p>See <a href="/courses/42/files/203/download?wrap=1">handout</a></p>',
    updated_at: "2026-01-02T00:00:00Z",
  };

  function discoveredFile(id: number, name: string): CanvasFile {
    return {
      id,
      display_name: name,
      filename: name,
      folder_id: 2,
      size: 10 * id,
      "content-type": "application/pdf",
      url: `https://cdn.test/${id}`,
      updated_at: "2026-01-01T00:00:00Z",
    };
  }

  function hiddenFilesClient(): { client: CanvasClient; calls: string[] } {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      calls.push(url.pathname);

      if (url.pathname === "/api/v1/courses/42/files") {
        return new Response(JSON.stringify({ status: "unauthorized" }), { status: 403 });
      }
      if (url.pathname === "/api/v1/courses/42/folders") return jsonResponse(HIDDEN_FOLDERS);
      if (url.pathname === "/api/v1/courses/42/modules") return jsonResponse(HIDDEN_MODULES);
      if (url.pathname === "/api/v1/courses/42/pages") return jsonResponse(HIDDEN_PAGES);
      if (url.pathname === "/api/v1/courses/42/pages/week-1") return jsonResponse(HIDDEN_PAGE_BODY);
      if (url.pathname === "/api/v1/courses/42/assignments") return jsonResponse([]);
      if (url.pathname === "/api/v1/files/201") return jsonResponse(discoveredFile(201, "Slides1.pdf"));
      if (url.pathname === "/api/v1/files/202") return jsonResponse(discoveredFile(202, "Slides2.pdf"));
      if (url.pathname === "/api/v1/files/203") return jsonResponse(discoveredFile(203, "Handout.pdf"));
      return new Response("not found", { status: 404 });
    };
    const client = new CanvasClient(
      { baseUrl: "https://cdn.test", token: "t", schoolRoot: "/tmp", currentSemester: 5 },
      { fetchImpl, sleep: async () => {} }
    );
    return { client, calls };
  }

  it("falls back to discovering files via modules + page bodies when /files 403s", async () => {
    const { client } = hiddenFilesClient();
    const result = await listAllFilesWithMeta(client, 42);

    expect(result.source).toBe("discovered");
    expect(result.discoveredSkipped).toBe(0);
    expect(result.files.map((f) => f.id).sort()).toEqual([201, 202, 203]);
    for (const f of result.files) {
      expect(f.folderPath).toBe("Slides");
      expect(f.source).toBe("discovered");
    }
  });

  it("listAllFiles wrapper returns just the discovered files array", async () => {
    const { client } = hiddenFilesClient();
    const files = await listAllFiles(client, 42);
    expect(files).toHaveLength(3);
  });

  it("counts individually-inaccessible discovered ids as skipped rather than failing", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/api/v1/courses/42/files") {
        return new Response(JSON.stringify({ status: "unauthorized" }), { status: 403 });
      }
      if (url.pathname === "/api/v1/courses/42/folders") return jsonResponse(HIDDEN_FOLDERS);
      if (url.pathname === "/api/v1/courses/42/modules") return jsonResponse(HIDDEN_MODULES);
      if (url.pathname === "/api/v1/courses/42/pages") return jsonResponse(HIDDEN_PAGES);
      if (url.pathname === "/api/v1/courses/42/pages/week-1") return jsonResponse(HIDDEN_PAGE_BODY);
      if (url.pathname === "/api/v1/courses/42/assignments") return jsonResponse([]);
      if (url.pathname === "/api/v1/files/201") return jsonResponse(discoveredFile(201, "Slides1.pdf"));
      if (url.pathname === "/api/v1/files/202") return new Response("forbidden", { status: 403 });
      if (url.pathname === "/api/v1/files/203") return jsonResponse(discoveredFile(203, "Handout.pdf"));
      return new Response("not found", { status: 404 });
    };
    const client = new CanvasClient(
      { baseUrl: "https://cdn.test", token: "t", schoolRoot: "/tmp", currentSemester: 5 },
      { fetchImpl, sleep: async () => {} }
    );

    const result = await listAllFilesWithMeta(client, 42);
    expect(result.discoveredSkipped).toBe(1);
    expect(result.files.map((f) => f.id).sort()).toEqual([201, 203]);
  });

  it("excludes TEMPLATE FILES from the discovered set too", async () => {
    const folders: Folder[] = [
      ...HIDDEN_FOLDERS,
      { id: 3, name: "TEMPLATE FILES", full_name: "course files/TEMPLATE FILES", parent_folder_id: 1, files_count: 1, folders_count: 0 },
    ];
    const modules = [
      {
        ...HIDDEN_MODULES[0],
        items: [
          ...HIDDEN_MODULES[0]!.items,
          { id: 103, title: "Junk icon", type: "File", content_id: 999 },
        ],
      },
    ];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/api/v1/courses/42/files") {
        return new Response(JSON.stringify({ status: "unauthorized" }), { status: 403 });
      }
      if (url.pathname === "/api/v1/courses/42/folders") return jsonResponse(folders);
      if (url.pathname === "/api/v1/courses/42/modules") return jsonResponse(modules);
      if (url.pathname === "/api/v1/courses/42/pages") return jsonResponse(HIDDEN_PAGES);
      if (url.pathname === "/api/v1/courses/42/pages/week-1") return jsonResponse(HIDDEN_PAGE_BODY);
      if (url.pathname === "/api/v1/courses/42/assignments") return jsonResponse([]);
      if (url.pathname === "/api/v1/files/201") return jsonResponse(discoveredFile(201, "Slides1.pdf"));
      if (url.pathname === "/api/v1/files/202") return jsonResponse(discoveredFile(202, "Slides2.pdf"));
      if (url.pathname === "/api/v1/files/203") return jsonResponse(discoveredFile(203, "Handout.pdf"));
      if (url.pathname === "/api/v1/files/999") {
        return jsonResponse({
          id: 999,
          display_name: "icon.png",
          filename: "icon.png",
          folder_id: 3,
          size: 1,
          "content-type": "image/png",
          url: "https://cdn.test/999",
          updated_at: "2026-01-01T00:00:00Z",
        });
      }
      return new Response("not found", { status: 404 });
    };
    const client = new CanvasClient(
      { baseUrl: "https://cdn.test", token: "t", schoolRoot: "/tmp", currentSemester: 5 },
      { fetchImpl, sleep: async () => {} }
    );

    const result = await listAllFilesWithMeta(client, 42);
    expect(result.files.some((f) => f.id === 999)).toBe(false);
    expect(result.files.map((f) => f.id).sort()).toEqual([201, 202, 203]);
  });
});

describe("listAllFiles — TEMPLATE FILES exclusion in listing mode", () => {
  it("excludes files under a TEMPLATE FILES folder when /files works normally", async () => {
    const folders: Folder[] = [
      ...FOLDERS,
      { id: 3, name: "TEMPLATE FILES", full_name: "course files/TEMPLATE FILES/Icons", parent_folder_id: 1, files_count: 1, folders_count: 0 },
    ];
    const files: CanvasFile[] = [
      ...FILES,
      {
        id: 999,
        display_name: "icon.png",
        filename: "icon.png",
        folder_id: 3,
        size: 1,
        "content-type": "image/png",
        url: "https://cdn.test/999",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/api/v1/courses/9/folders") return jsonResponse(folders);
      if (url.pathname === "/api/v1/courses/9/files") return jsonResponse(files);
      return new Response("not found", { status: 404 });
    };
    const client = new CanvasClient(
      { baseUrl: "https://cdn.test", token: "t", schoolRoot: "/tmp", currentSemester: 5 },
      { fetchImpl, sleep: async () => {} }
    );

    const result = await listAllFilesWithMeta(client, 9);
    expect(result.source).toBe("listing");
    expect(result.files.some((f) => f.id === 999)).toBe(false);
    expect(result.files.map((f) => f.id).sort()).toEqual([101, 102, 103]);
  });
});

describe("downloadFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "canvas-mcp-download-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("re-fetches the file to get a fresh URL before downloading", async () => {
    const { client, calls } = fakeClient();
    const files = await listAllFiles(client, 9);
    const file = files.find((f) => f.id === 101)!;

    const dest = join(dir, "yfirlit.pdf");
    const bytes = await downloadFile(client, file, dest);

    expect(calls).toContain("/api/v1/files/101");
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf-8")).toBe("file-bytes-here");
    expect(bytes).toBe(Buffer.byteLength("file-bytes-here"));
  });
});
