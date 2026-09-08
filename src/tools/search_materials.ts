import { homedir } from "node:os";
import { z } from "zod";
import type { FileEntry } from "../canvas/files.js";
import { listAllFiles } from "../canvas/files.js";
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

const inputSchema = {
  query: z.string().min(1, "query must not be empty"),
  course: z.string().optional().describe("Course slug, code, or id. Omit to search all current-semester courses."),
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
    const lockIcon = f.locked ? " 🔒" : "";
    const localPath = resolveLocalPath(ctx, candidate.course, f.id);
    const localPart = localPath
      ? `local: ${shortenHome(localPath)}`
      : "not synced (use download_file or sync_course)";
    return (
      `- ${coursePrefix} 📄 ${f.name}${lockIcon}  (${f.folderPath}) — ` +
      `${formatSize(f.size)} — file_id ${f.id} — ${localPart}`
    );
  }

  if (candidate.kind === "module_item") {
    const { item, moduleName } = candidate;
    const fileRef = item.type === "File" && item.contentId !== null ? ` (file_id ${item.contentId})` : "";
    const pageRef = item.type === "Page" && item.pageUrl ? ` (page_url: ${item.pageUrl})` : "";
    return `- ${coursePrefix} 📦 Module "${moduleName}" › ${item.title}${fileRef}${pageRef}`;
  }

  const p = candidate.page;
  return `- ${coursePrefix} 📃 page: ${p.title} (page_url: ${p.url})`;
}

async function gatherCandidates(ctx: ToolContext, course: CourseInfo): Promise<MaterialCandidate[]> {
  const [files, modules, pages] = await Promise.all([
    listAllFiles(ctx.client, course.id).catch(() => [] as FileEntry[]),
    listModules(ctx.client, course.id).catch(() => [] as ModuleInfo[]),
    listPages(ctx.client, course.id).catch(() => [] as PageSummary[]),
  ]);

  const candidates: MaterialCandidate[] = [];

  for (const f of files) {
    candidates.push({ kind: "file", title: f.name, updatedAt: f.updatedAt, course, file: f });
  }

  for (const m of modules) {
    for (const item of m.items) {
      candidates.push({
        kind: "module_item",
        title: item.title,
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

  return candidates;
}

export const tool = defineTool({
  name: "search_materials",
  description:
    "Search this course's (or all current courses') files, module items, and pages by name. " +
    "Ranks matches by relevance and reports each file's local synced path when already downloaded.",
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
    const candidates = perCourse.flat();

    const ranked = rankMaterials(input.query, candidates).slice(0, limit);

    if (ranked.length === 0) {
      return `No materials match "${input.query}".`;
    }

    return ranked.map(({ candidate }) => formatHit(ctx, candidate)).join("\n");
  },
});
