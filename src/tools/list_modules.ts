import { z } from "zod";
import { resolveCourse } from "../canvas/courses.js";
import { listModules } from "../canvas/modules.js";
import { defineTool } from "./_types.js";

/** Maps a module item's Canvas content type to the id parameter name the matching tool expects
 * (download_file's file_id, get_assignment's assignment_id, get_page's page_url, …), so the id
 * printed here can be copy-pasted straight into that tool's argument. */
function idKeyFor(type: string): string {
  switch (type) {
    case "File":
      return "file_id";
    case "Assignment":
      return "assignment_id";
    case "Quiz":
      return "quiz_id";
    case "Discussion":
      return "discussion_id";
    default:
      return "id";
  }
}

function typeLabel(type: string): string {
  switch (type) {
    case "File":
      return "file";
    case "Page":
      return "page";
    case "Assignment":
      return "assignment";
    case "ExternalUrl":
      return "link";
    case "SubHeader":
      return "heading";
    case "Quiz":
      return "quiz";
    case "Discussion":
      return "discussion";
    default:
      return type.toLowerCase();
  }
}

export const tool = defineTool({
  name: "list_modules",
  description:
    "Lists a course's modules and their items (files, pages, assignments, links, etc.) as a tree, with ids for use with download_file / get_page / get_assignment.",
  inputSchema: {
    course: z
      .union([z.string(), z.number()])
      .describe(
        'Course slug like "thyd", full code like "T-603-THYD", numeric Canvas id, or a distinctive word from the course name.',
      ),
  },
  handler: async (input, ctx) => {
    const course = await resolveCourse(ctx.client, input.course);
    const modules = await listModules(ctx.client, course.id);

    if (modules.length === 0) {
      return `${course.slug}: no modules.`;
    }

    const lines: string[] = [`${course.slug} (${course.code}) — ${modules.length} module(s)`];
    for (const mod of modules) {
      lines.push(`- [${mod.id}] ${mod.name}`);
      for (const item of mod.items) {
        const indent = "  ".repeat(1 + item.indent);
        const idPart =
          item.contentId !== null
            ? ` (${typeLabel(item.type)} ${idKeyFor(item.type)}=${item.contentId})`
            : item.pageUrl
              ? ` (${typeLabel(item.type)} page_url=${item.pageUrl})`
              : ` (${typeLabel(item.type)})`;
        lines.push(`${indent}- ${item.title}${idPart}`);
      }
    }
    return lines.join("\n");
  },
});
