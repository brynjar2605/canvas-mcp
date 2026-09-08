import { z } from "zod";
import { defineTool } from "./_types.js";
import { resolveCourse } from "../canvas/courses.js";
import { getPage } from "../canvas/pages.js";
import { formatReykjavikDateTime } from "../canvas/calendar.js";

export const tool = defineTool({
  name: "get_page",
  description: "Fetch one Canvas wiki page's body as markdown. Needs the page's url slug — find it with search_materials or list_modules first.",
  inputSchema: {
    course: z
      .union([z.string(), z.number()])
      .describe(
        'Course slug like "thyd", full code like "T-603-THYD", numeric Canvas id, or a distinctive word from the course name.',
      ),
    page_url: z
      .string()
      .describe(
        "Canvas page url slug, e.g. 'course-home-page' or 'assessment'. Get it from search_materials (shown as `page_url=...`) or from a Page item in list_modules (shown as `page_url=...`). Not the page title.",
      ),
  },
  handler: async (input, ctx) => {
    const course = await resolveCourse(ctx.client, input.course);
    const page = await getPage(ctx.client, course.id, input.page_url, course.slug);
    const updated = page.updatedAt ? ` (updated ${formatReykjavikDateTime(page.updatedAt)})` : "";
    const body = page.bodyMarkdown.trim();
    return `# ${page.title}${updated}\n\n${body || "(empty page)"}`;
  },
});
