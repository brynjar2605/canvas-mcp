import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CanvasClient } from "../src/canvas/client.js";
import { downloadFile, listAllFiles } from "../src/canvas/files.js";
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
