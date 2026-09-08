import { homedir } from "node:os";
import { z } from "zod";
import type { FileEntry } from "../canvas/files.js";
import { listAllFilesWithMeta } from "../canvas/files.js";
import type { ModuleInfo, ModuleItemInfo } from "../canvas/modules.js";
import { listModules } from "../canvas/modules.js";
import type { PageSummary } from "../canvas/pages.js";
import { listPages } from "../canvas/pages.js";
import { currentCourses, resolveCourse } from "../canvas/courses.js";
import type { CourseInfo } from "../canvas/courses.js";
import { canvasDir } from "../config.js";
import { loadManifest, localPathForFile } from "../sync/manifest.js";
import type { Candidate } from "../search.js";
import { rankMaterials } from "../search.js";
import type { ToolContext } from "./_types.js";
import { defineTool } from "./_types.js";

const COURSE_DESCRIBE =
  'Course slug like "thyd", full code like "T-603-THYD", numeric Canvas id, or a distinctive word from the course name. Omit for all current-semester courses.';

const inputSchema = {
  query: z
    .string()
    .min(1, "query must not be empty")
    .describe(
      "Words to match against file names, module item titles, and page titles — NOT file contents. Short and specific works best: 'lexical', 'vika 3', 'assignment 2'.",
    ),
  course: z.union([z.string(), z.number()]).optional().describe(COURSE_DESCRIBE),
  limit: z.number().int().positive().max(100).optional().describe("Max results to return (default 15)."),
};

interface FileCandidate extends Candidate {
  kind: "file";
  course: CourseInfo;
  file: FileEntry;
}
interface ModuleItemCandidate extends Candidate {
  kind: "module_item";
  course: CourseInfo;
  moduleName: string;
  item: ModuleItemInfo;
}
interface PageCandidate extends Candidate {
  kind: "page";
  course: CourseInfo;
  page: PageSummary;
}
type MaterialCandidate = FileCandidate | ModuleItemCandidate | PageCandidate;

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function shortenHome(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** Resolves a file's local synced path, if any. Never throws — sync state is best-effort context. */
function resolveLocalPath(ctx: ToolContext, course: CourseInfo, fileId: number): string | null {
  try {
    const semester = course.semester ?? ctx.config.currentSemester;
    if (semester === null) return null;
    const dir = canvasDir(course.slug, semester, ctx.config);
    const manifest = loadManifest(dir, course.id, course.slug);
    return localPathForFile(manifest, fileId);
  } catch {
    return null;
  }
}

function formatHit(ctx: ToolContext, candidate: MaterialCandidate): string {
  const coursePrefix = `[${candidate.course.slug}]`;

  if (candidate.kind === "file") {
    const f = candidate.file;
    const lockPart = f.locked ? " 🔒" : "";
    const folderPart = f.folderPath ? ` (${f.folderPath})` : " (course files root)";
    const localPath = resolveLocalPath(ctx, candidate.course, f.id);
    const localPart = localPath
      ? `local: ${shortenHome(localPath)}`
      : "not synced (use download_file or sync_course)";
    return (
      `- ${coursePrefix} file: ${f.name}${lockPart}${folderPart} — ` +
      `${formatSize(f.size)} — file_id ${f.id} — ${localPart}`
    );
  }

  if (candidate.kind === "module_item") {
    const { item, moduleName } = candidate;
    const fileRef = item.type === "File" && item.contentId !== null ? ` (file_id=${item.contentId})` : "";
    const pageRef = item.type === "Page" && item.pageUrl ? ` (page_url=${item.pageUrl})` : "";
    const assignmentRef =
      item.type === "Assignment" && item.contentId !== null ? ` (assignment_id=${item.contentId})` : "";
    return `- ${coursePrefix} module: "${moduleName}" › ${item.title}${fileRef}${pageRef}${assignmentRef}`;
  }

  const p = candidate.page;
  return `- ${coursePrefix} page: ${p.title} (page_url=${p.url})`;
}

interface CourseCandidates {
  candidates: MaterialCandidate[];
  /** "discovered" when this course hides its Files tab and the file list was reconstructed. */
  filesSource: "listing" | "discovered";
}

async function gatherCandidates(ctx: ToolContext, course: CourseInfo): Promise<CourseCandidates> {
  const [filesResult, modules, pages] = await Promise.all([
    listAllFilesWithMeta(ctx.client, course.id).catch(
      () => ({ files: [] as FileEntry[], source: "listing" as const, discoveredSkipped: 0 }),
    ),
    listModules(ctx.client, course.id).catch(() => [] as ModuleInfo[]),
    listPages(ctx.client, course.id).catch(() => [] as PageSummary[]),
  ]);

  const candidates: MaterialCandidate[] = [];

  for (const f of filesResult.files) {
    // Fold the folder path into the searched text so "slides" matches a file
    // filed under a "Slides" folder even when the filename itself doesn't
    // say "slides" (confirmed live: T-603-THYD-LexicalAnalysis.pdf in Slides/).
    const title = f.folderPath ? `${f.name} ${f.folderPath}` : f.name;
    candidates.push({ kind: "file", title, updatedAt: f.updatedAt, course, file: f });
  }

  for (const m of modules) {
    // Canvas module "SubHeader" items are section labels with no content of
    // their own (e.g. a "Slides" heading grouping the files under it) — fold
    // the most recent one into the following items' searched text too.
    let subheader = "";
    for (const item of m.items) {
      if (item.type === "SubHeader") {
        subheader = item.title;
      }
      const title = [item.title, m.name, subheader].filter(Boolean).join(" ");
      candidates.push({
        kind: "module_item",
        title,
        updatedAt: null,
        course,
        moduleName: m.name,
        item,
      });
    }
  }

  for (const p of pages) {
    candidates.push({ kind: "page", title: p.title, updatedAt: p.updatedAt, course, page: p });
  }

  return { candidates, filesSource: filesResult.source };
}

export const tool = defineTool({
  name: "search_materials",
  description:
    "Find course material by name across files, module items and pages — matches names/titles, not file " +
    "contents. Reports each file's file_id and, if already synced, its local path. Pass `course` when you know " +
    "which one: searching all courses at once has to crawl every course's modules and pages and is noticeably slower.",
  inputSchema,
  handler: async (input, ctx) => {
    const courses: CourseInfo[] = input.course
      ? [await resolveCourse(ctx.client, input.course)]
      : await currentCourses(ctx.client);

    if (courses.length === 0) {
      return "No current courses found to search. Pass an explicit `course` (slug, code, or id).";
    }

    const limit = input.limit ?? 15;
    const perCourse = await Promise.all(courses.map((course) => gatherCandidates(ctx, course)));
    const candidates = perCourse.flatMap((c) => c.candidates);

    const discoveredSlugs = courses
      .filter((_, i) => perCourse[i]!.filesSource === "discovered")
      .map((c) => c.slug);
    const footer =
      discoveredSlugs.length > 0
        ? `\n\nNote: ${discoveredSlugs.join(", ")} hide${discoveredSlugs.length === 1 ? "s" : ""} the Files tab — ` +
          `file results for ${discoveredSlugs.length === 1 ? "it" : "them"} come from modules/pages and may be incomplete.`
        : "";

    const ranked = rankMaterials(input.query, candidates).slice(0, limit);

    if (ranked.length === 0) {
      const slugs = courses.map((c) => c.slug).join(", ");
      return (
        `No file, module item or page in ${slugs} has a name matching "${input.query}". Names are matched, ` +
        `not contents — try fewer/shorter words (e.g. "lexical", "vika 3"), or browse with list_modules.${footer}`
      );
    }

    return ranked.map(({ candidate }) => formatHit(ctx, candidate)).join("\n") + footer;
  },
});
