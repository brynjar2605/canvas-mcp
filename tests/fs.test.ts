import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  atomicWriteText,
  ensureInside,
  extensionForContentType,
  renameDirSafe,
  safeFilename,
  sanitizeFilename,
  sanitizeFolderPath,
  withGuessedExtension,
} from "../src/util/fs.js";

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

  it("maps '.' and '..' to a safe placeholder rather than passing them through", () => {
    expect(sanitizeFilename(".")).toBe("_");
    expect(sanitizeFilename("..")).toBe("_");
  });
});

describe("safeFilename", () => {
  it("falls back when the name is empty", () => {
    expect(safeFilename("", "file-8001")).toBe("file-8001");
  });

  it("falls back for '.' and '..'", () => {
    expect(safeFilename(".", "file-1")).toBe("file-1");
    expect(safeFilename("..", "file-2")).toBe("file-2");
  });

  it("falls back for whitespace/underscore-only names", () => {
    expect(safeFilename("   ", "file-3")).toBe("file-3");
    expect(safeFilename("___", "file-4")).toBe("file-4");
  });

  it("keeps a usable original name unchanged", () => {
    expect(safeFilename("Yfirlit.pdf", "file-5")).toBe("Yfirlit.pdf");
  });
});

describe("extensionForContentType / withGuessedExtension", () => {
  it("maps common content-types to extensions", () => {
    expect(extensionForContentType("application/pdf")).toBe(".pdf");
    expect(extensionForContentType("image/png")).toBe(".png");
    expect(extensionForContentType("application/octet-stream")).toBeNull();
  });

  it("appends a guessed extension only when the name has none", () => {
    expect(withGuessedExtension("file-1", "application/pdf")).toBe("file-1.pdf");
    expect(withGuessedExtension("file-1.txt", "application/pdf")).toBe("file-1.txt");
    expect(withGuessedExtension("file-1", "application/octet-stream")).toBe("file-1");
  });
});

describe("sanitizeFolderPath", () => {
  it("sanitizes each segment independently", () => {
    expect(sanitizeFolderPath("Vika: 1")).toBe("Vika_ 1");
    expect(sanitizeFolderPath("Fyrirlestrar/Vika 3")).toBe("Fyrirlestrar/Vika 3");
  });

  it("drops segments that sanitize to nothing usable instead of throwing", () => {
    expect(sanitizeFolderPath("a/../b")).toBe("a/b");
    expect(sanitizeFolderPath("../../../../tmp/pwned")).toBe("tmp/pwned");
  });

  it("returns '' for an empty/root path", () => {
    expect(sanitizeFolderPath("")).toBe("");
  });
});

describe("ensureInside", () => {
  const root = "/tmp/canvas-mcp-root";

  it("allows a path inside root", () => {
    expect(ensureInside(root, join(root, "files", "a.pdf"))).toBe(join(root, "files", "a.pdf"));
  });

  it("rejects the root itself as a target — every write must land strictly inside root", () => {
    expect(() => ensureInside(root, root)).toThrow();
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

describe("ensureInside — symlink escape", () => {
  let realRoot: string;
  let outside: string;

  beforeEach(() => {
    realRoot = mkdtempSync(join(tmpdir(), "canvas-mcp-real-root-"));
    outside = mkdtempSync(join(tmpdir(), "canvas-mcp-outside-"));
  });

  afterEach(() => {
    rmSync(realRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("rejects a target under a symlinked directory that escapes root", () => {
    // realRoot/files -> outside (a sibling temp dir, not under realRoot at all).
    symlinkSync(outside, join(realRoot, "files"));
    expect(() => ensureInside(realRoot, join(realRoot, "files", "a.pdf"))).toThrow(/symlink/);
    expect(existsSync(join(outside, "a.pdf"))).toBe(false);
  });

  it("allows a target through a symlink that stays inside root", () => {
    const realSubdir = join(realRoot, "actual-files");
    mkdirSync(realSubdir);
    symlinkSync(realSubdir, join(realRoot, "files"));
    expect(ensureInside(realRoot, join(realRoot, "files", "a.pdf"))).toBe(join(realRoot, "files", "a.pdf"));
  });

  it("allows a target when root itself doesn't exist yet (dry run before first sync)", () => {
    const notYetCreated = join(realRoot, "does-not-exist-yet");
    expect(ensureInside(notYetCreated, join(notYetCreated, "files", "a.pdf"))).toBe(
      join(notYetCreated, "files", "a.pdf")
    );
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
