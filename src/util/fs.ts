// Filesystem safety helpers shared by the sync engine and tools.
//
// Rules from CLAUDE.md / PLAN.md: never delete user files, never write
// outside a course's canvas/ directory, keep Icelandic characters in
// filenames, and handle the macOS/APFS case-insensitive-but-case-preserving
// filesystem correctly when a folder rename only changes case.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";

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

/**
 * Resolves `target` against `root` and throws if the resolved path escapes
 * `root` (path traversal guard, e.g. a Canvas-supplied name containing `..`).
 * Returns the resolved absolute path on success.
 */
export function ensureInside(root: string, target: string): string {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + sep)) {
    throw new Error(`Refusing to write outside of ${resolvedRoot}: ${target}`);
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
