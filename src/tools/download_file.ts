import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { resolveCourse } from "../canvas/courses.js";
import { downloadFile, listAllFiles } from "../canvas/files.js";
import { canvasDir } from "../config.js";
import { ensureInside, sanitizeFilename } from "../util/fs.js";
import { defineTool } from "./_types.js";

export const tool = defineTool({
  name: "download_file",
  description:
    "Downloads a single Canvas file to disk under the course's canvas/files/ mirror (or a given dest, which must stay inside that course's canvas/ directory). Returns the absolute path written.",
  inputSchema: {
    course: z.union([z.string(), z.number()]).describe("Course slug, code, or id"),
    file_id: z.number().int().describe("Canvas file id (see list_modules or search_materials)"),
    dest: z
      .string()
      .optional()
      .describe("Optional destination path, relative to the course's canvas/ dir (or absolute, if inside it)"),
  },
  handler: async (input, ctx) => {
    const course = await resolveCourse(ctx.client, input.course);
    if (course.semester === null) {
      throw new Error(`Course "${course.slug}" has no derivable semester; cannot resolve its canvas/ dir.`);
    }

    const files = await listAllFiles(ctx.client, course.id);
    const file = files.find((f) => f.id === input.file_id);
    if (!file) {
      throw new Error(`File id ${input.file_id} not found in course "${course.slug}".`);
    }

    const dir = canvasDir(course.slug, course.semester, ctx.config);
    const defaultRel = file.folderPath
      ? join("files", file.folderPath, sanitizeFilename(file.name))
      : join("files", sanitizeFilename(file.name));
    const requestedPath = input.dest
      ? isAbsolute(input.dest)
        ? input.dest
        : join(dir, input.dest)
      : join(dir, defaultRel);
    const destPath = ensureInside(dir, requestedPath);

    const bytes = await downloadFile(ctx.client, file, destPath);
    return `Downloaded "${file.name}" (${bytes} bytes) to ${destPath}`;
  },
});
