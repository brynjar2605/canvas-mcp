// Filesystem safety helpers shared by the sync engine and tools.
//
// Rules from CLAUDE.md / PLAN.md: never delete user files, never write
// outside a course's canvas/ directory, keep Icelandic characters in
// filenames, and handle the macOS/APFS case-insensitive-but-case-preserving
// filesystem correctly when a folder rename only changes case.

import { lstatSync, mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";

/**
 * Sanitizes a Canvas display name into a safe filesystem path segment.
 *
 * - Keeps Icelandic letters (þ æ ö ð á é í ó ú ý, upper/lowercase) and spaces.
 * - Replaces `/`, `\`, `:` (colon breaks Finder / HFS+ paths) and control
 *   characters (0x00-0x1f, 0x7f) with `_`.
 * - Collapses repeated `_` runs into one.
 * - Trims leading/trailing whitespace.
 * - Caps the result at 200 characters, preserving the file extension
 *   (the last `.ext` segment, when short enough to be a real extension).
 */
export function sanitizeFilename(name: string): string {
  let s = name.replace(/[/\\:\x00-\x1f\x7f]/g, "_");
  s = s.replace(/_{2,}/g, "_");
  s = s.trim();
  if (s.length === 0) {
    s = "_";
  }
  // `.` and `..` are meaningful path segments (self / parent directory) —
  // never let a Canvas-supplied name collapse a join() back onto (or above)
  // the containing directory.
  if (s === "." || s === "..") {
    s = "_";
  }
  if (s.length > 200) {
    const dot = s.lastIndexOf(".");
    const looksLikeExtension = dot > 0 && s.length - dot <= 20;
    if (looksLikeExtension) {
      const ext = s.slice(dot);
      const base = s.slice(0, dot);
      const keep = Math.max(200 - ext.length, 1);
      s = base.slice(0, keep) + ext;
    } else {
      s = s.slice(0, 200);
    }
  }
  return s;
}

/** True when `s` is empty, or made up only of `_`, `.`, or whitespace — i.e.
 * not a usable display name (a bare fallback, or a degenerate original like
 * "", ".", "..", "   "). */
function isDegenerateName(s: string): boolean {
  return /^[_.\s]*$/.test(s);
}

/**
 * Like {@link sanitizeFilename}, but for names that must never collide or be
 * unreadable: if sanitizing `name` produces nothing usable (empty, ".", "..",
 * or only `_`/`.`/space), returns `fallback` instead (itself sanitized).
 * Callers pass a fallback derived from something guaranteed unique, e.g.
 * `file-<id>` or `page-<n>`.
 */
export function safeFilename(name: string, fallback: string): string {
  const s = sanitizeFilename(name);
  return isDegenerateName(s) ? sanitizeFilename(fallback) : s;
}

/** Canvas content-types we can confidently map to a familiar extension. */
const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "application/zip": ".zip",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "text/plain": ".txt",
};

/** Guesses a file extension (with leading dot) from a Canvas content-type, or null if unknown. */
export function extensionForContentType(contentType: string | undefined | null): string | null {
  if (!contentType) return null;
  return CONTENT_TYPE_EXTENSIONS[contentType.toLowerCase().trim()] ?? null;
}

/**
 * Appends an extension guessed from `contentType` to `name` when `name` has
 * none already. Used for fallback names (`file-<id>`) that carry no
 * extension of their own.
 */
export function withGuessedExtension(name: string, contentType: string | undefined | null): string {
  if (extname(name)) return name;
  const ext = extensionForContentType(contentType);
  return ext ? name + ext : name;
}

/**
 * Sanitizes every segment of a `/`-separated relative folder path (e.g. a
 * Canvas folder's `full_name` with the "course files" prefix stripped).
 * Segments that sanitize down to nothing usable (empty, ".", "..") are
 * dropped rather than aborting or replacing with a placeholder — so a single
 * bad segment shrinks the path instead of failing the sync.
 */
export function sanitizeFolderPath(folderPath: string): string {
  if (!folderPath) return "";
  return folderPath
    .split("/")
    .map((seg) => sanitizeFilename(seg))
    .filter((seg) => seg !== "" && seg !== "_")
    .join("/");
}

/**
 * Resolves `target` against `root` and throws if the resolved path escapes
 * `root` (path traversal guard, e.g. a Canvas-supplied name containing `..`),
 * INCLUDING when `target` resolves to `root` itself — every write this guards
 * must land strictly inside `root`, never overwrite it. Also resolves
 * symlinks along the existing portion of the path so a symlink planted
 * inside `root` (e.g. `canvas/files` pointed elsewhere) cannot redirect a
 * write outside of it, even though the guard is otherwise synchronous/lexical.
 * Returns the resolved absolute path on success.
 */
export function ensureInside(root: string, target: string): string {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (!resolvedTarget.startsWith(resolvedRoot + sep)) {
    throw new Error(`Refusing to write outside of ${resolvedRoot}: ${target}`);
  }

  let realRoot: string;
  try {
    realRoot = realpathSync(resolvedRoot);
  } catch {
    // Root doesn't exist yet (e.g. dry run, or before the first sync creates
    // it) — nothing has been created under it yet, so there is nothing a
    // symlink could already be redirecting. The lexical check above stands.
    return resolvedTarget;
  }

  // Walk the relative path component by component from the (real) root,
  // checking each existing component for a symlink that escapes realRoot.
  const relPath = resolvedTarget.slice(resolvedRoot.length + 1);
  let lexical = resolvedRoot;
  for (const part of relPath.split(sep)) {
    lexical = join(lexical, part);
    let st;
    try {
      st = lstatSync(lexical);
    } catch {
      // This component doesn't exist yet, so nothing under it can be a
      // symlink redirecting the write — safe to stop checking here.
      break;
    }
    if (st.isSymbolicLink()) {
      const real = realpathSync(lexical);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) {
        throw new Error(
          `Refusing to write outside of ${resolvedRoot} (symlink at ${lexical} escapes it): ${target}`
        );
      }
      lexical = real;
    }
  }

  return resolvedTarget;
}

/**
 * Writes text to `path` atomically: writes to a sibling temp file then
 * renames into place, so a crash mid-write never leaves a truncated file.
 * Creates parent directories as needed.
 */
export async function atomicWriteText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(tmp, text, "utf-8");
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * Synchronous atomic text write (same strategy as {@link atomicWriteText}),
 * used where callers need a sync API (e.g. the manifest, saved frequently
 * from inside async loops without wanting to `await` every save).
 */
export function atomicWriteTextSync(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, text, "utf-8");
  renameSync(tmp, path);
}

/**
 * Renames a directory, safely handling the case where the source and
 * destination differ only in case on a case-insensitive-but-case-preserving
 * filesystem (APFS default on macOS): a direct `rename("POSH", "posh")` on
 * such a filesystem can be a no-op or fail, because the OS considers them
 * the same path. We detect this (destination exists and is the *same*
 * directory, by device+inode) and go through a temporary name first.
 *
 * Throws if `to` exists and is a *different* directory than `from` — never
 * silently overwrites or deletes an existing folder.
 */
export async function renameDirSafe(from: string, to: string): Promise<void> {
  const fromResolved = resolve(from);
  const toResolved = resolve(to);

  if (fromResolved === toResolved) {
    return;
  }

  const fromStat = await stat(fromResolved).catch(() => null);
  if (!fromStat) {
    throw new Error(`renameDirSafe: source does not exist: ${fromResolved}`);
  }
  if (!fromStat.isDirectory()) {
    throw new Error(`renameDirSafe: source is not a directory: ${fromResolved}`);
  }

  await mkdir(dirname(toResolved), { recursive: true });

  const toStat = await stat(toResolved).catch(() => null);

  if (toStat) {
    const sameDir = toStat.dev === fromStat.dev && toStat.ino === fromStat.ino;
    if (!sameDir) {
      throw new Error(
        `renameDirSafe: target already exists and is a different directory: ${toResolved}`
      );
    }
    // Same directory under a different case (case-insensitive filesystem).
    // Two-step rename through a temp name forces the FS to update the
    // display case.
    const tmp = `${toResolved}.__canvas_tmp__`;
    await rename(fromResolved, tmp);
    await rename(tmp, toResolved);
    return;
  }

  await rename(fromResolved, toResolved);
}

/** Re-exported for callers that want the extension of a sanitized filename. */
export { extname };
