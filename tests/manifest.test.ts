import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadManifest, localPathForFile, saveManifest } from "../src/sync/manifest.js";

describe("manifest", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "canvas-mcp-manifest-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty manifest when the file is missing", () => {
    const m = loadManifest(dir, 42, "thyd");
    expect(m).toEqual({ version: 1, courseId: 42, slug: "thyd", lastSyncAt: null, files: {}, pages: {} });
  });

  it("round-trips a saved manifest", () => {
    const m = loadManifest(dir, 42, "thyd");
    m.lastSyncAt = "2026-01-01T00:00:00Z";
    m.files["101"] = { fileId: 101, path: "files/a.pdf", updatedAt: "2026-01-01T00:00:00Z", size: 10, syncedAt: "2026-01-01T00:00:01Z" };
    m.pages["front-page"] = { path: "pages/Front-page.md", updatedAt: "2026-01-01T00:00:00Z" };

    saveManifest(dir, m);

    const reloaded = loadManifest(dir, 42, "thyd");
    expect(reloaded).toEqual(m);
  });

  it("saves atomically (no leftover temp file)", () => {
    const m = loadManifest(dir, 42, "thyd");
    saveManifest(dir, m);
    const entries = readdirSync(dir);
    expect(entries).toEqual([".canvas-sync.json"]);
  });

  it("falls back to an empty manifest on corrupt JSON", () => {
    writeFileSync(join(dir, ".canvas-sync.json"), "{ not valid json ][");
    const m = loadManifest(dir, 42, "thyd");
    expect(m).toEqual({ version: 1, courseId: 42, slug: "thyd", lastSyncAt: null, files: {}, pages: {} });
  });

  it("falls back to an empty manifest on an unrecognised shape", () => {
    writeFileSync(join(dir, ".canvas-sync.json"), JSON.stringify({ version: 2, foo: "bar" }));
    const m = loadManifest(dir, 42, "thyd");
    expect(m.version).toBe(1);
    expect(m.files).toEqual({});
  });

  describe("localPathForFile", () => {
    it("returns null for a file not in the manifest", () => {
      const m = loadManifest(dir, 42, "thyd");
      expect(localPathForFile(m, 999)).toBeNull();
    });

    it("returns null when the manifest entry exists but the file was removed from disk", () => {
      const m = loadManifest(dir, 42, "thyd");
      m.files["101"] = { fileId: 101, path: "files/a.pdf", updatedAt: "x", size: 1, syncedAt: "x" };
      expect(localPathForFile(m, 101)).toBeNull();
    });

    it("returns the absolute path when the file is present on disk", () => {
      const m = loadManifest(dir, 42, "thyd");
      mkdirSync(join(dir, "files"), { recursive: true });
      writeFileSync(join(dir, "files", "a.pdf"), "content");
      m.files["101"] = { fileId: 101, path: "files/a.pdf", updatedAt: "x", size: 7, syncedAt: "x" };

      const path = localPathForFile(m, 101);
      expect(path).toBe(join(dir, "files", "a.pdf"));
      expect(existsSync(path!)).toBe(true);
    });
  });
});
