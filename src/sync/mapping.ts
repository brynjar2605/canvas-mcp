// Proposes and applies the mapping between Canvas courses and on-disk
// course folders under `<schoolRoot>/onn <semester>/`. See PLAN.md "Live
// findings" for the concrete onn-5 scenario this is built around.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CourseInfo } from "../canvas/courses.js";
import type { CourseMapping } from "../config.js";
import { loadCourseMapping, saveCourseMapping } from "../config.js";
import { renameDirSafe } from "../util/fs.js";

export interface MappingProposal {
  semester: number;
  /** relative folder name, e.g. "onn 5" */
  semesterDir: string;
  entries: Array<{
    courseId: number;
    code: string;
    slug: string;
    name: string;
    existingFolder: string | null;
    action: "keep" | "rename" | "create";
  }>;
  /** existing folders in the semester dir that no course matched */
  unmatchedFolders: string[];
}

/** Lowercase, strip diacritics (NFD + drop combining marks) for fuzzy matching. */
function normalise(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

/**
 * Proposes a mapping from Canvas courses (for `semester`) to on-disk
 * folders. Auto-match rule: an existing folder name (normalised) equals a
 * course's slug, or equals any normalised word (>= 4 chars) of the course's
 * full name. `overrides` (existing folder name -> slug) always win over
 * auto-matching, and are tried first.
 *
 * Never mutates anything — pure proposal. Folders not claimed by any course
 * are reported in `unmatchedFolders` so the caller can fill gaps with
 * `overrides` and re-propose.
 */
export function proposeMapping(
  courses: CourseInfo[],
  semester: number,
  existingFolders: string[],
  overrides: Record<string, string> = {}
): MappingProposal {
  const semCourses = courses.filter((c) => c.semester === semester);
  const usedFolders = new Set<string>();
  const entries: MappingProposal["entries"] = [];

  for (const c of semCourses) {
    let existingFolder: string | null = null;

    // 1. explicit overrides win.
    for (const [folder, slug] of Object.entries(overrides)) {
      if (usedFolders.has(folder)) continue;
      if (slug === c.slug && existingFolders.includes(folder)) {
        existingFolder = folder;
        break;
      }
    }

    // 2. auto-match by normalised folder name vs slug / name words.
    if (existingFolder === null) {
      const nameWords = c.name
        .split(/\s+/)
        .map(normalise)
        .filter((w) => w.length >= 4);

      for (const folder of existingFolders) {
        if (usedFolders.has(folder)) continue;
        // a folder explicitly overridden to a *different* course is not
        // available for auto-matching.
        if (overrides[folder] && overrides[folder] !== c.slug) continue;

        const nf = normalise(folder);
        if (nf === c.slug || nameWords.includes(nf)) {
          existingFolder = folder;
          break;
        }
      }
    }

    let action: "keep" | "rename" | "create";
    if (existingFolder === null) {
      action = "create";
    } else if (existingFolder === c.slug) {
      action = "keep";
    } else {
      action = "rename";
    }

    if (existingFolder) usedFolders.add(existingFolder);
    entries.push({ courseId: c.id, code: c.code, slug: c.slug, name: c.name, existingFolder, action });
  }

  const unmatchedFolders = existingFolders.filter((f) => !usedFolders.has(f));

  return { semester, semesterDir: `onn ${semester}`, entries, unmatchedFolders };
}

export interface ApplyMappingOptions {
  schoolRoot: string;
  /** override config/courses.json location, mainly for tests */
  mappingPath?: string;
}

/**
 * Applies a proposal: renames folders (case-only renames handled safely),
 * creates missing folders, and writes `config/courses.json`. Never deletes
 * anything. Refuses (throws, via `renameDirSafe`) if a rename target
 * already exists as a *different* directory — callers should re-propose
 * with `overrides` instead of forcing through a conflict.
 *
 * Returns a list of human-readable log lines describing what happened.
 */
export async function applyMapping(
  proposal: MappingProposal,
  opts: ApplyMappingOptions
): Promise<string[]> {
  const log: string[] = [];
  const semDirAbs = join(opts.schoolRoot, proposal.semesterDir);
  await mkdir(semDirAbs, { recursive: true });

  const mapping: CourseMapping = loadCourseMapping(opts.mappingPath);

  for (const entry of proposal.entries) {
    const targetPath = join(semDirAbs, entry.slug);

    if (entry.action === "rename" && entry.existingFolder) {
      const fromPath = join(semDirAbs, entry.existingFolder);
      await renameDirSafe(fromPath, targetPath);
      log.push(`renamed: ${entry.existingFolder} -> ${entry.slug}`);
    } else if (entry.action === "create") {
      if (existsSync(targetPath)) {
        log.push(`exists: ${entry.slug} (already present, left as-is)`);
      } else {
        await mkdir(targetPath, { recursive: true });
        log.push(`created: ${proposal.semesterDir}/${entry.slug}`);
      }
    } else {
      log.push(`kept: ${entry.slug}`);
    }

    mapping[String(entry.courseId)] = {
      code: entry.code,
      slug: entry.slug,
      semester: proposal.semester,
    };
  }

  saveCourseMapping(mapping, opts.mappingPath);
  log.push(`wrote course mapping (${proposal.entries.length} entries)`);

  if (proposal.unmatchedFolders.length > 0) {
    log.push(`unmatched folders left untouched: ${proposal.unmatchedFolders.join(", ")}`);
  }

  return log;
}
