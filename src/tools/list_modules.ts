import { z } from "zod";
import { resolveCourse } from "../canvas/courses.js";
import { listModules } from "../canvas/modules.js";
import { defineTool } from "./_types.js";

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
    course: z.union([z.string(), z.number()]).describe("Course slug, code, or id"),
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
            ? ` (${typeLabel(item.type)} id=${item.contentId})`
            : item.pageUrl
              ? ` (${typeLabel(item.type)} url=${item.pageUrl})`
              : ` (${typeLabel(item.type)})`;
        lines.push(`${indent}- ${item.title}${idPart}`);
      }
    }
    return lines.join("\n");
  },
});
