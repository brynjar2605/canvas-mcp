// Mirrors a course's Canvas Files, Modules and Pages onto disk under
// `<canvasDir>/{files,modules,pages}`. Idempotent via the manifest: skips
// anything unchanged, never deletes, and reports (but leaves in place)
// anything that disappeared from Canvas since the last sync.

import { existsSync, statSync } from "node:fs";
import { copyFile, lstat, mkdir, symlink, unlink } from "node:fs/promises";
import { dirname, extname, join, parse as parsePath, relative } from "node:path";
import type { CanvasClient } from "../canvas/client.js";
import type { CourseInfo } from "../canvas/courses.js";
import { folderForCourse, getConfig } from "../config.js";
import { downloadFile, listAllFilesWithMeta, type FileEntry } from "../canvas/files.js";
import { listModules, type ModuleItemInfo } from "../canvas/modules.js";
import { getPage, listPages, type PageSummary } from "../canvas/pages.js";
import {
  atomicWriteText,
  ensureInside,
  safeFilename,
  sanitizeFilename,
  sanitizeFolderPath,
  withGuessedExtension,
} from "../util/fs.js";
import { mapWithConcurrency } from "../util/concurrency.js";
import { loadManifest, saveManifest, type Manifest } from "./manifest.js";

export interface SyncOptions {
  dryRun?: boolean;
  /** default true */
  includePages?: boolean;
  /** default true */
  includeModules?: boolean;
}

export interface SyncReport {
  slug: string;
  /** Absolute path to the course's canvas/ dir (set once it's known, even in dry-run). */
  dir?: string;
  added: string[];
  updated: string[];
  skipped: number;
  failed: Array<{ path: string; error: string }>;
  removedOnCanvas: string[];
  /** Advisory lines that aren't failures: kept-edited-copy notices, user-file-preserved skips, etc. */
  warnings: string[];
  dryRun: boolean;
  /** "discovered" when this course hides its Files tab and the file list was reconstructed from modules/pages. */
  source?: "listing" | "discovered";
  /** Discovered file ids that individually 401/403/404'd and were dropped (only set when source is "discovered"). */
  discoveredSkipped?: number;
  /** How many discovered files were found via an announcement (only set when source is "discovered" and > 0). */
  announcementDiscoveredCount?: number;
}

const SAVE_EVERY_N = 10;
const DOWNLOAD_CONCURRENCY = 3;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function withIdSuffix(name: string, id: number): string {
  const dot = name.lastIndexOf(".");
  if (dot > 0) return `${name.slice(0, dot)} (${id})${name.slice(dot)}`;
  return `${name} (${id})`;
}

/** `<name> (canvas <yyyy-mm-dd>)<ext>` — where a locally-edited file's new Canvas version is saved. */
function withCanvasDateSuffix(relPath: string, isoDateTime: string | undefined): string {
  const dateStr = isoDateTime && !Number.isNaN(Date.parse(isoDateTime)) ? isoDateTime.slice(0, 10) : new Date().toISOString().slice(0, 10);
  const { dir, name, ext } = parsePath(relPath);
  return dir ? join(dir, `${name} (canvas ${dateStr})${ext}`) : `${name} (canvas ${dateStr})${ext}`;
}

/**
 * Deterministically assigns a relative path (under "files/") to every
 * FileEntry.
 *
 * Sticky: an id already recorded in the manifest keeps its existing path —
 * even if the sibling that originally forced a " (id)" suffix onto it has
 * since disappeared from Canvas. New (not-yet-tracked) files are grouped by
 * folder + sanitized name; within a group the lowest id gets the plain name
 * *unless* that exact path is already claimed by a different, still-on-disk
 * manifest entry, in which case it (and every other file in the group) gets
 * " (id)" suffixed. This is what keeps duplicate-`display_name` files from
 * being silently reassigned onto each other's bytes across runs.
 */
function assignFilePaths(files: FileEntry[], manifest: Manifest, dir: string): Map<number, string> {
  const result = new Map<number, string>();
  const claimedByOnDiskEntry = new Map<string, number>();
  for (const [idStr, entry] of Object.entries(manifest.files)) {
    if (existsSync(join(dir, entry.path))) {
      claimedByOnDiskEntry.set(entry.path, Number(idStr));
    }
  }

  const remaining: FileEntry[] = [];
  for (const f of files) {
    const existing = manifest.files[String(f.id)];
    if (existing) {
      result.set(f.id, existing.path);
      // A sticky path is claimed by this id whether or not the file is
      // currently on disk — otherwise a user who deletes a synced file frees
      // its name for a *new* same-named Canvas file, and both ids then race
      // onto the same path.
      claimedByOnDiskEntry.set(existing.path, f.id);
    } else {
      remaining.push(f);
    }
  }

  const groups = new Map<string, { folderPath: string; safeName: string; files: FileEntry[] }>();
  for (const f of remaining) {
    const folderPath = sanitizeFolderPath(f.folderPath);
    const safeName = withGuessedExtension(safeFilename(f.name, `file-${f.id}`), f.contentType);
    const key = JSON.stringify([folderPath, safeName]);
    let g = groups.get(key);
    if (!g) {
      g = { folderPath, safeName, files: [] };
      groups.set(key, g);
    }
    g.files.push(f);
  }

  for (const { folderPath, safeName, files: group } of groups.values()) {
    const sorted = [...group].sort((a, b) => a.id - b.id);
    for (const f of sorted) {
      const plainRel = folderPath ? join("files", folderPath, safeName) : join("files", safeName);
      const claimant = claimedByOnDiskEntry.get(plainRel);
      const rel =
        claimant === undefined || claimant === f.id
          ? plainRel
          : folderPath
            ? join("files", folderPath, withIdSuffix(safeName, f.id))
            : join("files", withIdSuffix(safeName, f.id));
      claimedByOnDiskEntry.set(rel, f.id);
      result.set(f.id, rel);
    }
  }

  return result;
}

/**
 * Pages are named by their Canvas `url` slug, not their title: RU's course
 * template imports pages in triplicate with identical titles (`Assessment`
 * at urls `assessment`, `assessment-2`, `assessment-3`), and `url` is
 * unique, stable and already filesystem-safe — so unlike files, no
 * manifest-based stickiness is needed here at all.
 */
function assignPagePaths(pages: PageSummary[]): Map<string, string> {
  const result = new Map<string, string>();
  const taken = new Set<string>();
  // Assigned in url order (not listing order) so the tie-break below is
  // stable across runs even if Canvas reorders the listing.
  const ordered = [...pages].sort((a, b) => a.url.localeCompare(b.url));
  for (const [i, p] of ordered.entries()) {
    const slug = safeFilename(p.url, `page-${i + 1}`);
    let rel = join("pages", `${slug}.md`);
    for (let n = 2; taken.has(rel); n++) {
      rel = join("pages", `${slug} (${n}).md`);
    }
    taken.add(rel);
    result.set(p.url, rel);
  }
  return result;
}

/**
 * Symlinks `linkAbs` -> `targetAbs` (relative), falling back to a copy if
 * symlinking fails. Never deletes anything at `linkAbs` that we didn't
 * create ourselves: only a symlink (presumably from a previous sync) is
 * replaced. A regular file there is left untouched and reported.
 */
async function linkOrCopy(
  targetAbs: string,
  linkAbs: string,
  linkRel: string,
  report: SyncReport
): Promise<void> {
  await mkdir(dirname(linkAbs), { recursive: true });
  const st = await lstat(linkAbs).catch(() => null);
  if (st) {
    if (!st.isSymbolicLink()) {
      report.warnings.push(`skipped: user file exists at ${linkRel}`);
      return;
    }
    await unlink(linkAbs);
  }
  const rel = relative(dirname(linkAbs), targetAbs);
  try {
    await symlink(rel, linkAbs);
  } catch {
    await copyFile(targetAbs, linkAbs);
  }
}

export async function syncCourse(
  client: CanvasClient,
  course: CourseInfo,
  opts: SyncOptions = {}
): Promise<SyncReport> {
  const dryRun = opts.dryRun ?? false;
  const includePages = opts.includePages ?? true;
  const includeModules = opts.includeModules ?? true;

  const cfg = getConfig();
  const { slug, dir } = folderForCourse(course, cfg);

  const manifest = loadManifest(dir, course.id, slug);

  const report: SyncReport = {
    slug,
    dir,
    added: [],
    updated: [],
    skipped: 0,
    failed: [],
    removedOnCanvas: [],
    warnings: [],
    dryRun,
  };

  if (!dryRun) {
    await mkdir(dir, { recursive: true });
  }

  let sinceSave = 0;
  const maybeSave = () => {
    sinceSave++;
    if (!dryRun && sinceSave >= SAVE_EVERY_N) {
      saveManifest(dir, manifest);
      sinceSave = 0;
    }
  };

  // ---- Files ----
  const filesResult = await listAllFilesWithMeta(client, course.id);
  const files = filesResult.files;
  report.source = filesResult.source;
  if (filesResult.source === "discovered") {
    report.discoveredSkipped = filesResult.discoveredSkipped;
    const announcementCount = files.filter((f) => f.discoveredVia?.includes("announcement")).length;
    if (announcementCount > 0) {
      report.announcementDiscoveredCount = announcementCount;
    }
  }
  const filePathById = assignFilePaths(files, manifest, dir);
  const fileById = new Map(files.map((f) => [f.id, f] as const));
  const seenFileIds = new Set<number>();

  await mapWithConcurrency(files, DOWNLOAD_CONCURRENCY, async (file) => {
    seenFileIds.add(file.id);
    const relPath = filePathById.get(file.id)!;

    try {
      const absPath = ensureInside(dir, join(dir, relPath));
      const existing = manifest.files[String(file.id)];
      const unchanged =
        !!existing &&
        existing.updatedAt === file.updatedAt &&
        existing.size === file.size &&
        existsSync(absPath);

      if (unchanged) {
        report.skipped++;
        return;
      }

      if (dryRun) {
        (existing ? report.updated : report.added).push(relPath);
        return;
      }

      // If this is an update (not a first-time download) and the file
      // currently on disk doesn't match what we last recorded, the user
      // edited it locally — never clobber that. Save Canvas's new version
      // alongside instead.
      let writeRelPath = relPath;
      let keptEditedCopy = false;
      if (existing) {
        const onDiskStat = existsSync(absPath) ? statSync(absPath) : null;
        if (onDiskStat && onDiskStat.size !== existing.size) {
          writeRelPath = withCanvasDateSuffix(relPath, file.updatedAt);
          keptEditedCopy = true;
        }
      }
      const writeAbsPath = ensureInside(dir, join(dir, writeRelPath));

      await downloadFile(client, file, writeAbsPath, dir);
      manifest.files[String(file.id)] = {
        fileId: file.id,
        path: relPath,
        updatedAt: file.updatedAt,
        size: file.size,
        syncedAt: new Date().toISOString(),
      };
      if (keptEditedCopy) {
        report.warnings.push(`⚠ kept your edited copy: ${relPath} (Canvas's new version saved as ${writeRelPath})`);
      } else {
        (existing ? report.updated : report.added).push(relPath);
      }
      maybeSave();
    } catch (err) {
      report.failed.push({ path: relPath, error: err instanceof Error ? err.message : String(err) });
    }
  });

  for (const [fileIdStr, entry] of Object.entries(manifest.files)) {
    if (!seenFileIds.has(Number(fileIdStr))) {
      report.removedOnCanvas.push(entry.path);
    }
  }

  // ---- Pages ----
  if (includePages) {
    const pages = await listPages(client, course.id);
    const pagePathByUrl = assignPagePaths(pages);
    const seenPageUrls = new Set<string>();

    for (const meta of pages) {
      seenPageUrls.add(meta.url);
      const relPath = pagePathByUrl.get(meta.url)!;

      try {
        const absPath = ensureInside(dir, join(dir, relPath));
        const existing = manifest.pages[meta.url];
        const unchanged = !!existing && existing.updatedAt === (meta.updatedAt ?? "") && existsSync(absPath);

        if (unchanged) {
          report.skipped++;
          continue;
        }

        if (dryRun) {
          (existing ? report.updated : report.added).push(relPath);
          continue;
        }

        const full = await getPage(client, course.id, meta.url);
        const updatedAt = full.updatedAt ?? meta.updatedAt ?? "";
        const content = `---\ntitle: ${full.title}\ncanvas_url: ${full.url}\nupdated: ${updatedAt}\n---\n\n${full.bodyMarkdown}\n`;
        await atomicWriteText(absPath, content);
        manifest.pages[meta.url] = { path: relPath, updatedAt };
        (existing ? report.updated : report.added).push(relPath);
        maybeSave();
      } catch (err) {
        report.failed.push({ path: relPath, error: err instanceof Error ? err.message : String(err) });
      }
    }

    for (const [url, entry] of Object.entries(manifest.pages)) {
      if (!seenPageUrls.has(url)) {
        report.removedOnCanvas.push(entry.path);
      }
    }
  }

  // ---- Modules ----
  if (includeModules) {
    const modules = await listModules(client, course.id);
    for (const mod of modules) {
      const modDirRel = join("modules", `${pad2(mod.position)} - ${sanitizeFilename(mod.name)}`);
      const externalLinks: string[] = [];

      let itemIdx = 0;
      for (const item of mod.items) {
        itemIdx++;
        const nn = pad2(itemIdx);
        try {
          await processModuleItem(item, nn);
        } catch (err) {
          report.failed.push({
            path: join(modDirRel, item.title),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (externalLinks.length > 0) {
        const linksRel = join(modDirRel, "links.md");
        if (dryRun) {
          report.added.push(linksRel);
        } else {
          try {
            const linksAbs = ensureInside(dir, join(dir, linksRel));
            await atomicWriteText(linksAbs, externalLinks.join("\n") + "\n");
          } catch (err) {
            report.failed.push({ path: linksRel, error: err instanceof Error ? err.message : String(err) });
          }
        }
      }

      async function processModuleItem(item: ModuleItemInfo, nn: string): Promise<void> {
        switch (item.type) {
          case "File": {
            if (item.contentId === null) return;
            const fe = fileById.get(item.contentId);
            const targetRel = fe ? filePathById.get(fe.id) : undefined;
            if (!fe || !targetRel) {
              // Not necessarily an error: the file may have been excluded as a
              // TEMPLATE FILES junk asset, or (in discovered mode) skipped
              // because it individually 401/403/404'd — either way, quietly
              // skip rather than failing the whole module.
              return;
            }
            const ext = extname(fe.name);
            const linkRel = join(modDirRel, `${nn} - ${sanitizeFilename(item.title)}${ext}`);
            if (dryRun) {
              report.added.push(linkRel);
              return;
            }
            const linkAbs = ensureInside(dir, join(dir, linkRel));
            const targetAbs = ensureInside(dir, join(dir, targetRel));
            await linkOrCopy(targetAbs, linkAbs, linkRel, report);
            return;
          }
          case "Page": {
            if (!item.pageUrl) return;
            const relPath = join(modDirRel, `${nn} - ${sanitizeFilename(item.title)}.md`);
            if (dryRun) {
              report.added.push(relPath);
              return;
            }
            const full = await getPage(client, course.id, item.pageUrl);
            const updatedAt = full.updatedAt ?? "";
            const content = `---\ntitle: ${full.title}\ncanvas_url: ${full.url}\nupdated: ${updatedAt}\n---\n\n${full.bodyMarkdown}\n`;
            const absPath = ensureInside(dir, join(dir, relPath));
            await atomicWriteText(absPath, content);
            return;
          }
          case "ExternalUrl": {
            if (item.externalUrl) {
              externalLinks.push(`- [${item.title}](${item.externalUrl})`);
            }
            return;
          }
          default:
            // Assignment, Quiz, Discussion, SubHeader, ExternalTool, etc. — not files, skip.
            return;
        }
      }
    }
  }

  if (!dryRun) {
    manifest.lastSyncAt = new Date().toISOString();
    manifest.lastFilesSource = filesResult.source;
    manifest.lastDiscoveredSkipped = filesResult.source === "discovered" ? filesResult.discoveredSkipped : undefined;
    saveManifest(dir, manifest);
  }

  return report;
}
