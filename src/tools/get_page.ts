import { z } from "zod";
import { defineTool } from "./_types.js";
import { resolveCourse } from "../canvas/courses.js";
import { getPage } from "../canvas/pages.js";

export const tool = defineTool({
  name: "get_page",
  description: "Fetch a Canvas wiki page's body as markdown.",
  inputSchema: {
    course: z.string().describe("Course slug, code, or id."),
    page_url: z.string().describe("Page url slug (from list_pages or a module item), e.g. 'course-syllabus'."),
  },
  handler: async (input, ctx) => {
    const course = await resolveCourse(ctx.client, input.course);
    const page = await getPage(ctx.client, course.id, input.page_url);
    const updated = page.updatedAt ? ` (updated ${page.updatedAt})` : "";
    const body = page.bodyMarkdown.trim();
    return `# ${page.title}${updated}\n\n${body || "(empty page)"}`;
  },
});
