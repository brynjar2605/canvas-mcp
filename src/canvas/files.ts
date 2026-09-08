import type { CanvasClient } from "./client.js";
import { CanvasApiError, CanvasAuthError } from "./client.js";
import type { CanvasFile, Folder } from "./types.js";
import { listModules } from "./modules.js";
import { getPage, listPages } from "./pages.js";
import { mapWithConcurrency } from "../util/concurrency.js";

/** Compact, LLM-friendly file record used across sync + tools. */
export interface FileEntry {
  id: number;
  /** display_name */
  name: string;
  /** relative folder path, "" for root, e.g. "Fyrirlestrar/Vika 3" */
  folderPath: string;
  size: number;
  contentType: string;
  updatedAt: string;
  url: string;
  locked: boolean;
  /**
   * "listing" when `GET /courses/:id/files` worked normally; "discovered" when
   * that endpoint was forbidden and the file list was instead reconstructed
   * from modules/pages/assignments (see `listAllFilesWithMeta`) — in which
   * case the list may be incomplete.
   */
  source: "listing" | "discovered";
}

const FILES_TTL_MS = 10 * 60 * 1000;
const DISCOVERY_CONCURRENCY = 4;

/**
 * Canvas folder `full_name` looks like "course files" (root) or
 * "course files/Fyrirlestrar/Vika 3". Strip the leading "course files"
 * segment so folderPath is relative to the course's file root.
 */
function stripCourseFilesPrefix(fullName: string): string {
  const parts = fullName.split("/");
  if (parts[0] === "course files") {
    parts.shift();
  }
  return parts.join("/");
}

/** Confirmed live: `course files/TEMPLATE FILES/Images/Icons` etc. hold ~150 junk RU template icons. */
function isTemplateFilesPath(folderPath: string): boolean {
  return folderPath.toLowerCase().startsWith("template files");
}

/**
 * True when Canvas denied access to a whole-course listing endpoint (as
 * opposed to some other error). 403 surfaces as `CanvasApiError` with
 * `status === 403`; 401 is special-cased by the client into `CanvasAuthError`
 * (no `.status` field) rather than `CanvasApiError`, so both are checked.
 */
function isAccessDenied(err: unknown): boolean {
  if (err instanceof CanvasApiError) return err.status === 401 || err.status === 403;
  return err instanceof CanvasAuthError;
}

async function buildFolderPathMap(client: CanvasClient, courseId: number): Promise<Map<number, string>> {
  const folders = await client.getAll<Folder>(`/api/v1/courses/${courseId}/folders`, undefined, FILES_TTL_MS);
  const folderPathById = new Map<number, string>();
  for (const folder of folders) {
    folderPathById.set(folder.id, stripCourseFilesPrefix(folder.full_name));
  }
  return folderPathById;
}

function toFileEntry(
  f: CanvasFile,
  folderPathById: Map<number, string>,
  source: "listing" | "discovered",
): FileEntry {
  return {
    id: f.id,
    name: f.display_name,
    folderPath: folderPathById.get(f.folder_id) ?? "",
    size: f.size,
    contentType: f["content-type"] ?? "application/octet-stream",
    updatedAt: f.updated_at ?? f.modified_at ?? "",
    url: f.url,
    locked: Boolean(f.locked || f.hidden || f.locked_for_user),
    source,
  };
}

/** Matches `href`/`src`/`data-api-endpoint` attributes that reference a Canvas file, in any of the
 * shapes seen live: `/courses/:id/files/:fid`, `/files/:fid`, with `?wrap=1` or `/download` suffixes,
 * or a full `data-api-endpoint="https://.../api/v1/courses/:id/files/:fid"`. */
const FILE_ID_ATTR_RE = /(?:href|src|data-api-endpoint)\s*=\s*["']([^"']*\/files\/(\d+)[^"']*)["']/gi;

/** Pulls Canvas file ids out of an HTML blob (page body / assignment description). */
function extractFileIds(html: string | null | undefined): number[] {
  if (!html) return [];
  const ids = new Set<number>();
  let match: RegExpExecArray | null;
  FILE_ID_ATTR_RE.lastIndex = 0;
  while ((match = FILE_ID_ATTR_RE.exec(html)) !== null) {
    const id = Number(match[2]);
    if (Number.isFinite(id)) ids.add(id);
  }
  return [...ids];
}

/** Straight-line list when `GET /courses/:id/files` is allowed (the normal case). */
async function listViaListing(client: CanvasClient, courseId: number): Promise<FileEntry[]> {
  const [folderPathById, files] = await Promise.all([
    buildFolderPathMap(client, courseId),
    client.getAll<CanvasFile>(`/api/v1/courses/${courseId}/files`, undefined, FILES_TTL_MS),
  ]);
  return files
    .map((f) => toFileEntry(f, folderPathById, "listing"))
    .filter((f) => !isTemplateFilesPath(f.folderPath));
}

/**
 * Reconstructs the set of file ids reachable by a student when the Files tab
 * itself is hidden (RU does this for most courses): every module item of
 * type "File", plus any `/files/:id` link found in page bodies or assignment
 * descriptions.
 */
async function discoverFileIds(client: CanvasClient, courseId: number): Promise<Set<number>> {
  const ids = new Set<number>();

  const modules = await listModules(client, courseId);
  for (const mod of modules) {
    for (const item of mod.items) {
      if (item.type === "File" && item.contentId !== null) {
        ids.add(item.contentId);
      }
    }
  }

  const pages = await listPages(client, courseId);
  for (const p of pages) {
    try {
      const full = await getPage(client, courseId, p.url);
      for (const id of extractFileIds(full.bodyHtml)) ids.add(id);
    } catch {
      // A single page failing to load shouldn't abort discovery for the rest.
    }
  }

  const assignments = await client.getAll<{ description?: string | null }>(
    `/api/v1/courses/${courseId}/assignments`,
    undefined,
    FILES_TTL_MS,
  );
  for (const a of assignments) {
    for (const id of extractFileIds(a.description)) ids.add(id);
  }

  return ids;
}

async function fetchDiscoveredFiles(
  client: CanvasClient,
  ids: Set<number>,
  folderPathById: Map<number, string>,
): Promise<{ files: FileEntry[]; skipped: number }> {
  const files: FileEntry[] = [];
  let skipped = 0;

  await mapWithConcurrency([...ids], DISCOVERY_CONCURRENCY, async (id) => {
    try {
      const f = await client.get<CanvasFile>(`/api/v1/files/${id}`, undefined, FILES_TTL_MS);
      files.push(toFileEntry(f, folderPathById, "discovered"));
    } catch (err) {
      if (isAccessDenied(err) || (err instanceof CanvasApiError && err.status === 404)) {
        skipped++;
        return;
      }
      throw err;
    }
  });

  return { files, skipped };
}

export interface ListAllFilesResult {
  files: FileEntry[];
  source: "listing" | "discovered";
  /** Discovered ids that individually 401/403/404'd on `GET /files/:id` and were dropped. */
  discoveredSkipped: number;
}

/**
 * All files in a course's Files area, flattened with their folder path
 * resolved. Locked/hidden files are included (with `locked: true`) rather
 * than dropped, so callers like search can still surface them.
 *
 * When `GET /courses/:id/files` itself is forbidden (RU hides the Files tab
 * for most courses students are enrolled in), falls back to discovering files
 * via modules, pages and assignment descriptions instead — `source` tells
 * callers which mode produced the result, and `discoveredSkipped` how many
 * discovered ids couldn't individually be fetched.
 */
export async function listAllFilesWithMeta(client: CanvasClient, courseId: number): Promise<ListAllFilesResult> {
  try {
    const files = await listViaListing(client, courseId);
    return { files, source: "listing", discoveredSkipped: 0 };
  } catch (err) {
    if (!isAccessDenied(err)) throw err;
  }

  const [folderPathById, ids] = await Promise.all([
    buildFolderPathMap(client, courseId),
    discoverFileIds(client, courseId),
  ]);
  const { files, skipped } = await fetchDiscoveredFiles(client, ids, folderPathById);
  const filtered = files.filter((f) => !isTemplateFilesPath(f.folderPath));

  return { files: filtered, source: "discovered", discoveredSkipped: skipped };
}

/** Thin wrapper over `listAllFilesWithMeta` for callers that don't need the source/skip metadata. */
export async function listAllFiles(client: CanvasClient, courseId: number): Promise<FileEntry[]> {
  return (await listAllFilesWithMeta(client, courseId)).files;
}

/**
 * Downloads a single file to `destPath`. Canvas's `file.url` is a
 * pre-signed download URL that expires; since we can't tell from a
 * `FileEntry` alone whether it came from the (10m TTL) cache, we always
 * re-fetch `GET /api/v1/files/:id` immediately before downloading to get a
 * fresh URL. Returns the number of bytes written.
 */
export async function downloadFile(
  client: CanvasClient,
  file: FileEntry,
  destPath: string
): Promise<number> {
  const fresh = await client.get<CanvasFile>(`/api/v1/files/${file.id}`);
  return client.downloadToFile(fresh.url, destPath);
}
