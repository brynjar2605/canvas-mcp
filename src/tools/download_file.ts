import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { resolveCourse } from "../canvas/courses.js";
import { downloadFile, listAllFiles } from "../canvas/files.js";
import { folderForCourse } from "../config.js";
import { ensureInside, safeFilename, withGuessedExtension } from "../util/fs.js";
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

    const files = await listAllFiles(ctx.client, course.id);
    const file = files.find((f) => f.id === input.file_id);
    if (!file) {
      throw new Error(`File id ${input.file_id} not found in course "${course.slug}".`);
    }

    const { dir } = folderForCourse(course, ctx.config);
    const safeName = withGuessedExtension(safeFilename(file.name, `file-${file.id}`), file.contentType);
    const defaultRel = file.folderPath ? join("files", file.folderPath, safeName) : join("files", safeName);
    const requestedPath = input.dest
      ? isAbsolute(input.dest)
        ? input.dest
        : join(dir, input.dest)
      : join(dir, defaultRel);
    const destPath = ensureInside(dir, requestedPath);

    const bytes = await downloadFile(ctx.client, file, destPath, dir);
    return `Downloaded "${file.name}" (${bytes} bytes) to ${destPath}`;
  },
});
