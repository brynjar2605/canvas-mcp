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
import { folderForCourse } from "../config.js";
import { loadManifest, localPathForFile } from "../sync/manifest.js";
import type { Candidate, CandidateKind } from "../search.js";
import { KIND_ORDER, rankMaterials } from "../search.js";
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
    // Honour config/courses.json (post-rename folder names); falls back to the derived slug/semester.
    const { dir, slug } = folderForCourse(
      { ...course, semester: course.semester ?? ctx.config.currentSemester },
      ctx.config,
    );
    const manifest = loadManifest(dir, course.id, slug);
    return localPathForFile(manifest, fileId);
  } catch {
    return null;
  }
}

/** One (moduleName, item title) pair, for the "in module …" context appended
 * to a merged file/page result — see `mergeDuplicates` below. */
interface ModuleContext {
  moduleName: string;
  itemTitle: string;
}

function formatModuleContext(contexts: ModuleContext[]): string {
  if (contexts.length === 0) return "";
  const parts = contexts.map((c) => `"${c.moduleName}" › ${c.itemTitle}`).join("; ");
  return ` — in module ${parts}`;
}

function formatHit(ctx: ToolContext, candidate: MaterialCandidate, contexts: ModuleContext[]): string {
  const coursePrefix = `[${candidate.course.slug}]`;
  const contextPart = formatModuleContext(contexts);

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
      `${formatSize(f.size)} — file_id ${f.id}${contextPart} — ${localPart}`
    );
  }

  if (candidate.kind === "page") {
    const p = candidate.page;
    return `- ${coursePrefix} page: ${p.title} (page_url=${p.url})${contextPart}`;
  }

  // module_item with no separate file/page candidate to merge into (e.g. a
  // discovered course whose file listing doesn't cover this content_id) —
  // render the best line we can from the module item alone.
  const { item, moduleName } = candidate;
  if (item.type === "ExternalUrl") {
    return `- ${coursePrefix} link: ${item.title}${item.externalUrl ? ` (${item.externalUrl})` : ""}`;
  }
  if (item.type === "File" && item.contentId !== null) {
    return (
      `- ${coursePrefix} file: ${item.title} — file_id ${item.contentId}${contextPart} — ` +
      "not synced (use download_file or sync_course)"
    );
  }
  if (item.type === "Page" && item.pageUrl) {
    return `- ${coursePrefix} page: ${item.title} (page_url=${item.pageUrl})${contextPart}`;
  }
  const assignmentRef =
    item.type === "Assignment" && item.contentId !== null ? ` (assignment_id=${item.contentId})` : "";
  return `- ${coursePrefix} module: "${moduleName}" › ${item.title}${assignmentRef}`;
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
    // the most recent one into the following items' searched text too, but
    // never surface the SubHeader itself as a result (there's nothing to open).
    let subheader = "";
    for (const item of m.items) {
      if (item.type === "SubHeader") {
        subheader = item.title;
        continue;
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

/** Groups candidates that describe the same underlying file/page so they can
 * be merged into a single result: `file:<courseId>:<fileId>` /
 * `page:<courseId>:<pageUrl>` for anything (a `file`/`page` candidate, or a
 * `module_item` of type File/Page) that points at it, `null` for everything
 * else (module items with no separate content identity — Assignment, Quiz,
 * Discussion, ExternalUrl — each of those stays its own result). */
function mergeKeyFor(candidate: MaterialCandidate): string | null {
  if (candidate.kind === "file") return `file:${candidate.course.id}:${candidate.file.id}`;
  if (candidate.kind === "page") return `page:${candidate.course.id}:${candidate.page.url}`;
  const { item } = candidate;
  if (item.type === "File" && item.contentId !== null) return `file:${candidate.course.id}:${item.contentId}`;
  if (item.type === "Page" && item.pageUrl) return `page:${candidate.course.id}:${item.pageUrl}`;
  return null;
}

interface MergedResult {
  score: number;
  kind: CandidateKind;
  updatedAt?: string | null;
  /** The candidate whose own data renders the line — a `file`/`page` candidate
   * when one is known (it carries size/folder/local-path or the page url),
   * otherwise the module item itself. */
  primary: MaterialCandidate;
  contexts: ModuleContext[];
}

/**
 * The live Canvas data behind search_materials routinely surfaces the same
 * file/page twice — once as its own `file`/`page` candidate, once again as
 * the module item that links to it (e.g. a "Front End" module's "Chapter 3"
 * item pointing at file_id 2672865, which also appears in the plain file
 * listing). Callers don't want two lines for one document, so candidates
 * that share a `mergeKeyFor` key are collapsed into one `MergedResult`: the
 * best-scoring member's score wins, a `file`/`page` candidate (which carries
 * the real metadata) is preferred as the line's `primary` over a bare module
 * item, and every module item in the group contributes an "in module …"
 * context line. Candidates with no merge key (Assignment/Quiz/Discussion/
 * ExternalUrl module items, or a file/page nothing else references) each
 * become their own singleton group, so this also serves as the final result
 * list after `rankMaterials` — re-sorted here since merging can change which
 * score represents a given line.
 */
function mergeDuplicates(ranked: { candidate: MaterialCandidate; score: number }[]): MergedResult[] {
  const fileByKey = new Map<string, FileCandidate>();
  const pageByKey = new Map<string, PageCandidate>();
  for (const { candidate } of ranked) {
    if (candidate.kind === "file") fileByKey.set(`file:${candidate.course.id}:${candidate.file.id}`, candidate);
    else if (candidate.kind === "page") pageByKey.set(`page:${candidate.course.id}:${candidate.page.url}`, candidate);
  }

  const groups = new Map<string, MergedResult>();
  const order: string[] = [];
  let anonymousCounter = 0;

  for (const { candidate, score } of ranked) {
    const key = mergeKeyFor(candidate) ?? `single:${anonymousCounter++}`;
    let group = groups.get(key);
    if (!group) {
      let primary: MaterialCandidate = candidate;
      if (candidate.kind === "module_item") {
        const { item } = candidate;
        if (item.type === "File" && item.contentId !== null) {
          primary = fileByKey.get(`file:${candidate.course.id}:${item.contentId}`) ?? candidate;
        } else if (item.type === "Page" && item.pageUrl) {
          primary = pageByKey.get(`page:${candidate.course.id}:${item.pageUrl}`) ?? candidate;
        }
      }
      group = { score, kind: primary.kind, updatedAt: primary.updatedAt, primary, contexts: [] };
      groups.set(key, group);
      order.push(key);
    } else {
      if (score > group.score) group.score = score;
      // A `file`/`page` candidate carries real metadata a bare module item lacks — prefer it if seen later.
      if (group.primary.kind === "module_item" && candidate.kind !== "module_item") {
        group.primary = candidate;
        group.kind = candidate.kind;
        group.updatedAt = candidate.updatedAt;
      }
    }
    if (candidate.kind === "module_item") {
      const ctx: ModuleContext = { moduleName: candidate.moduleName, itemTitle: candidate.item.title };
      if (!group.contexts.some((c) => c.moduleName === ctx.moduleName && c.itemTitle === ctx.itemTitle)) {
        group.contexts.push(ctx);
      }
    }
  }

  const results = order.map((key) => groups.get(key)!);
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const kindDiff = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (kindDiff !== 0) return kindDiff;
    const at = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const bt = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    return bt - at;
  });
  return results;
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

    const ranked = rankMaterials(input.query, candidates);
    const merged = mergeDuplicates(ranked).slice(0, limit);

    if (merged.length === 0) {
      const slugs = courses.map((c) => c.slug).join(", ");
      return (
        `No file, module item or page in ${slugs} has a name matching "${input.query}". Names are matched, ` +
        `not contents — try fewer/shorter words (e.g. "lexical", "vika 3"), or browse with list_modules.${footer}`
      );
    }

    return merged.map((m) => formatHit(ctx, m.primary, m.contexts)).join("\n") + footer;
  },
});
