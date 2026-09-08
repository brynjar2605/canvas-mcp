import type { CanvasClient } from "./client.js";
import type { CanvasFile, Folder } from "./types.js";

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
}

const FILES_TTL_MS = 10 * 60 * 1000;

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

/**
 * All files in a course's Files area, flattened with their folder path
 * resolved. Locked/hidden files are included (with `locked: true`) rather
 * than dropped, so callers like search can still surface them.
 */
export async function listAllFiles(client: CanvasClient, courseId: number): Promise<FileEntry[]> {
  const [folders, files] = await Promise.all([
    client.getAll<Folder>(`/api/v1/courses/${courseId}/folders`, undefined, FILES_TTL_MS),
    client.getAll<CanvasFile>(`/api/v1/courses/${courseId}/files`, undefined, FILES_TTL_MS),
  ]);

  const folderPathById = new Map<number, string>();
  for (const folder of folders) {
    folderPathById.set(folder.id, stripCourseFilesPrefix(folder.full_name));
  }

  return files.map((f) => ({
    id: f.id,
    name: f.display_name,
    folderPath: folderPathById.get(f.folder_id) ?? "",
    size: f.size,
    contentType: f["content-type"] ?? "application/octet-stream",
    updatedAt: f.updated_at ?? f.modified_at ?? "",
    url: f.url,
    locked: Boolean(f.locked || f.hidden),
  }));
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
