import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { currentCourses, resolveCourse } from "../canvas/courses.js";
import { ConfigError, folderForCourse } from "../config.js";
import { loadManifest } from "../sync/manifest.js";
import { defineTool } from "./_types.js";

export const tool = defineTool({
  name: "sync_status",
  description:
    "Shows sync status for one course, or all current-semester courses: last sync time, file/page counts tracked, manifest size, and whether the canvas/ folder exists yet.",
  inputSchema: {
    course: z
      .union([z.string(), z.number()])
      .optional()
      .describe("Course slug, code, or id; omit for all current-semester courses"),
  },
  handler: async (input, ctx) => {
    const targets =
      input.course !== undefined ? [await resolveCourse(ctx.client, input.course)] : await currentCourses(ctx.client);

    if (targets.length === 0) {
      return "No current-semester courses found.";
    }

    const lines: string[] = [];
    for (const course of targets) {
      let dir: string;
      try {
        ({ dir } = folderForCourse(course, ctx.config));
      } catch (err) {
        if (err instanceof ConfigError) {
          lines.push(`${course.slug}: no derivable semester — cannot locate its canvas/ dir.`);
          continue;
        }
        throw err;
      }

      if (!existsSync(dir)) {
        lines.push(`${course.slug}: never synced (${dir} does not exist).`);
        continue;
      }

      const manifest = loadManifest(dir, course.id, course.slug);
      const manifestFile = join(dir, ".canvas-sync.json");
      const manifestSize = existsSync(manifestFile) ? statSync(manifestFile).size : 0;
      const fileCount = Object.keys(manifest.files).length;
      const pageCount = Object.keys(manifest.pages).length;

      lines.push(
        `${course.slug}: last sync ${manifest.lastSyncAt ?? "never"}; ${fileCount} file(s), ${pageCount} page(s) tracked; manifest ${manifestSize} bytes; folder present at ${dir}`
      );
      if (manifest.lastFilesSource === "discovered") {
        lines.push(
          `  ℹ Files tab is hidden for this course — file list is discovered via modules/pages (may be incomplete)` +
            (manifest.lastDiscoveredSkipped ? `; ${manifest.lastDiscoveredSkipped} discovered link(s) skipped as inaccessible` : ""),
        );
      }
    }
    return lines.join("\n");
  },
});
