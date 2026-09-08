// Per-course sync manifest: <canvasDir>/.canvas-sync.json
//
// Tracks which Canvas files/pages have been mirrored to disk so `syncCourse`
// can skip unchanged content and never re-download or delete anything
// unnecessarily.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextSync } from "../util/fs.js";

export interface ManifestEntry {
  fileId: number;
  /** relative to canvasDir */
  path: string;
  updatedAt: string;
  size: number;
  syncedAt: string;
}

export interface Manifest {
  version: 1;
  courseId: number;
  slug: string;
  lastSyncAt: string | null;
  /** keyed by fileId (as string) */
  files: Record<string, ManifestEntry>;
  /** keyed by Canvas page url */
  pages: Record<string, { path: string; updatedAt: string }>;
}

const MANIFEST_FILENAME = ".canvas-sync.json";

/**
 * Manifest objects don't carry their own canvasDir (per the public shape),
 * but `localPathForFile` needs it to resolve an absolute path. We stash it
 * out-of-band, keyed by object identity, set by `loadManifest`.
 */
const canvasDirOf = new WeakMap<Manifest, string>();

function manifestPath(canvasDir: string): string {
  return join(canvasDir, MANIFEST_FILENAME);
}

function emptyManifest(courseId: number, slug: string): Manifest {
  return { version: 1, courseId, slug, lastSyncAt: null, files: {}, pages: {} };
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Loads the manifest for a course. Returns a fresh empty manifest (never
 * throws) if the file is missing, unreadable, or its JSON is malformed or
 * of an unrecognised shape.
 */
export function loadManifest(canvasDir: string, courseId: number, slug: string): Manifest {
  const path = manifestPath(canvasDir);
  let manifest: Manifest;

  if (!existsSync(path)) {
    manifest = emptyManifest(courseId, slug);
  } else {
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (
        !isPlainRecord(parsed) ||
        parsed.version !== 1 ||
        !isPlainRecord(parsed.files) ||
        !isPlainRecord(parsed.pages)
      ) {
        manifest = emptyManifest(courseId, slug);
      } else {
        manifest = {
          version: 1,
          courseId: typeof parsed.courseId === "number" ? parsed.courseId : courseId,
          slug: typeof parsed.slug === "string" ? parsed.slug : slug,
          lastSyncAt: typeof parsed.lastSyncAt === "string" ? parsed.lastSyncAt : null,
          files: parsed.files as Manifest["files"],
          pages: parsed.pages as Manifest["pages"],
        };
      }
    } catch {
      manifest = emptyManifest(courseId, slug);
    }
  }

  canvasDirOf.set(manifest, canvasDir);
  return manifest;
}

/** Saves the manifest atomically (write to temp file, then rename). */
export function saveManifest(canvasDir: string, m: Manifest): void {
  atomicWriteTextSync(manifestPath(canvasDir), JSON.stringify(m, null, 2) + "\n");
  canvasDirOf.set(m, canvasDir);
}

/**
 * Absolute path on disk for a previously-synced file, or null if it isn't
 * in the manifest or isn't actually present on disk (e.g. the user deleted
 * it, or it was never synced by a manifest loaded through `loadManifest`).
 */
export function localPathForFile(m: Manifest, fileId: number): string | null {
  const entry = m.files[String(fileId)];
  if (!entry) return null;
  const canvasDir = canvasDirOf.get(m);
  if (!canvasDir) return null;
  const abs = join(canvasDir, entry.path);
  return existsSync(abs) ? abs : null;
}
