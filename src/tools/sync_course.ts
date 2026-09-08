import { z } from "zod";
import { currentCourses, resolveCourse } from "../canvas/courses.js";
import { syncCourse, type SyncReport } from "../sync/engine.js";
import { defineTool } from "./_types.js";

/** Renders a SyncReport as plain text, used by both this tool and the CLI. */
export function formatSyncReport(r: SyncReport): string {
  const summary = `${r.slug}${r.dryRun ? " (dry run)" : ""}: +${r.added.length} added, ~${r.updated.length} updated, ${r.skipped} skipped, ${r.failed.length} failed, ${r.removedOnCanvas.length} removed-on-canvas`;
  const lines = [summary];
  if (r.source === "discovered") {
    const fileCount = r.added.length + r.updated.length + r.skipped;
    lines.push(
      `  ℹ Files tab is hidden for this course — synced ${fileCount} file(s) discovered via modules/pages` +
        (r.discoveredSkipped ? ` (${r.discoveredSkipped} discovered link(s) skipped as inaccessible)` : "") +
        ` (may be incomplete)`,
    );
  }
  for (const p of r.added) lines.push(`  + ${p}`);
  for (const p of r.updated) lines.push(`  ~ ${p}`);
  for (const f of r.failed) lines.push(`  ! ${f.path}: ${f.error}`);
  for (const p of r.removedOnCanvas) lines.push(`  x ${p} (missing on Canvas — left on disk)`);
  return lines.join("\n");
}

export const tool = defineTool({
  name: "sync_course",
  description:
    "Downloads new/changed files, pages, and module structure for a course (or 'all' current-semester courses) into its canvas/ mirror. Idempotent, never deletes local files.",
  inputSchema: {
    course: z.string().describe('Course slug, code, or id (as a string), or "all" for all current-semester courses'),
    dry_run: z.boolean().optional().describe("Report what would change without writing or downloading anything"),
    include_pages: z.boolean().optional().describe("Default true"),
    include_modules: z.boolean().optional().describe("Default true"),
  },
  handler: async (input, ctx) => {
    const opts = {
      dryRun: input.dry_run,
      includePages: input.include_pages,
      includeModules: input.include_modules,
    };

    const targets =
      input.course.trim().toLowerCase() === "all"
        ? await currentCourses(ctx.client)
        : [await resolveCourse(ctx.client, input.course)];

    if (targets.length === 0) {
      return "No current-semester courses to sync.";
    }

    const reports: SyncReport[] = [];
    for (const course of targets) {
      reports.push(await syncCourse(ctx.client, course, opts));
    }
    return reports.map(formatSyncReport).join("\n\n");
  },
});
