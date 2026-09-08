import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteText, ensureInside, renameDirSafe, sanitizeFilename } from "../src/util/fs.js";

describe("sanitizeFilename", () => {
  it("keeps Icelandic characters and spaces", () => {
    expect(sanitizeFilename("Þýðendur – Fyrirlestur 3.pdf")).toBe("Þýðendur – Fyrirlestur 3.pdf");
    expect(sanitizeFilename("Áætlun_í_stýrikerfum.docx")).toBe("Áætlun_í_stýrikerfum.docx");
  });

  it("replaces path separators and colons with underscore", () => {
    expect(sanitizeFilename("a/b\\c:d.txt")).toBe("a_b_c_d.txt");
  });

  it("strips control characters", () => {
    expect(sanitizeFilename("bad\x00name\x1f.txt")).toBe("bad_name_.txt");
  });

  it("collapses repeated underscores", () => {
    expect(sanitizeFilename("a///b.txt")).toBe("a_b.txt");
    expect(sanitizeFilename("a___b.txt")).toBe("a_b.txt");
  });

  it("trims whitespace", () => {
    expect(sanitizeFilename("  spaced.txt  ")).toBe("spaced.txt");
  });

  it("caps length at 200 chars, preserving the extension", () => {
    const longName = "a".repeat(250) + ".pdf";
    const result = sanitizeFilename(longName);
    expect(result.length).toBe(200);
    expect(result.endsWith(".pdf")).toBe(true);
  });

  it("caps length at 200 chars when there is no real extension", () => {
    const longName = "a".repeat(250);
    const result = sanitizeFilename(longName);
    expect(result.length).toBe(200);
  });

  it("never returns an empty string", () => {
    expect(sanitizeFilename("")).not.toBe("");
    expect(sanitizeFilename("   ")).not.toBe("");
  });
});

describe("ensureInside", () => {
  const root = "/tmp/canvas-mcp-root";

  it("allows a path inside root", () => {
    expect(ensureInside(root, join(root, "files", "a.pdf"))).toBe(join(root, "files", "a.pdf"));
  });

  it("allows root itself", () => {
    expect(ensureInside(root, root)).toBe(root);
  });

  it("rejects a path traversal attempt", () => {
    expect(() => ensureInside(root, join(root, "..", "evil.txt"))).toThrow();
  });

  it("rejects an absolute path outside root", () => {
    expect(() => ensureInside(root, "/etc/passwd")).toThrow();
  });

  it("rejects a sibling directory whose name is prefixed by root's name", () => {
    // "/tmp/canvas-mcp-root-evil" starts with the string "/tmp/canvas-mcp-root" but
    // is not actually inside it — a naive startsWith check without the separator
    // would wrongly allow this.
    expect(() => ensureInside(root, root + "-evil/x.txt")).toThrow();
  });
});

describe("atomicWriteText", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "canvas-mcp-atomic-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the file and creates parent directories", async () => {
    const path = join(dir, "nested", "deep", "file.txt");
    await atomicWriteText(path, "hello world");
    expect(readFileSync(path, "utf-8")).toBe("hello world");
  });

  it("leaves no leftover temp files", async () => {
    const path = join(dir, "file.txt");
    await atomicWriteText(path, "content");
    const entries = readdirSync(dir);
    expect(entries).toEqual(["file.txt"]);
  });
});

describe("renameDirSafe", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "canvas-mcp-rename-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("performs a normal rename", async () => {
    const from = join(dir, "old");
    const to = join(dir, "new");
    mkdirSync(from);
    writeMarker(from);

    await renameDirSafe(from, to);

    expect(existsSync(from)).toBe(false);
    expect(existsSync(to)).toBe(true);
    expect(readMarker(to)).toBe("marker");
  });

  it("handles a case-only rename on a case-insensitive filesystem", async () => {
    const from = join(dir, "POSH");
    const to = join(dir, "posh");
    mkdirSync(from);
    writeMarker(from);

    await renameDirSafe(from, to);

    // On a case-insensitive FS, existsSync would report true for either
    // casing — the real assertion is that the directory listing now shows
    // the *new* case.
    const entries = readdirSync(dir);
    expect(entries).toContain("posh");
    expect(entries).not.toContain("POSH");
    expect(readMarker(join(dir, "posh"))).toBe("marker");
  });

  it("is a no-op when from and to resolve to the same path", async () => {
    const from = join(dir, "same");
    mkdirSync(from);
    writeMarker(from);
    await expect(renameDirSafe(from, from)).resolves.toBeUndefined();
    expect(readMarker(from)).toBe("marker");
  });

  it("throws if the source does not exist", async () => {
    await expect(renameDirSafe(join(dir, "nope"), join(dir, "target"))).rejects.toThrow();
  });

  it("refuses to overwrite a different existing directory", async () => {
    const from = join(dir, "a");
    const to = join(dir, "b");
    mkdirSync(from);
    mkdirSync(to);
    writeMarker(from);
    writeMarker(to, "other");

    await expect(renameDirSafe(from, to)).rejects.toThrow(/already exists/);

    // Neither side should have been touched.
    expect(existsSync(from)).toBe(true);
    expect(existsSync(to)).toBe(true);
    expect(readMarker(to)).toBe("other");
  });
});

function writeMarker(dir: string, content = "marker"): void {
  writeFileSync(join(dir, "marker.txt"), content);
}

function readMarker(dir: string): string {
  return readFileSync(join(dir, "marker.txt"), "utf-8");
}
