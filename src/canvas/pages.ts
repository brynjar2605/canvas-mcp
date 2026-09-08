import type { CanvasClient } from "./client.js";
import { CanvasApiError } from "./client.js";
import type { Page } from "./types.js";
import { htmlToMarkdown } from "../util/html.js";

export interface PageSummary {
  url: string;
  title: string;
  updatedAt: string | null;
  frontPage: boolean;
}

const PAGES_LIST_TTL_MS = 10 * 60 * 1000;

function toPageSummary(p: Page): PageSummary {
  return {
    url: p.url,
    title: p.title,
    updatedAt: p.updated_at ?? null,
    frontPage: p.front_page ?? false,
  };
}

/**
 * Lists a course's wiki pages. Some courses have the Pages feature disabled
 * entirely, in which case Canvas returns 403/404 — treated as "no pages"
 * rather than an error, since this is a normal course configuration.
 */
export async function listPages(client: CanvasClient, courseId: number): Promise<PageSummary[]> {
  try {
    const raw = await client.getAll<Page>(
      `/api/v1/courses/${courseId}/pages`,
      undefined,
      PAGES_LIST_TTL_MS,
    );
    return raw.map(toPageSummary);
  } catch (err) {
    if (err instanceof CanvasApiError && (err.status === 403 || err.status === 404)) {
      return [];
    }
    throw err;
  }
}

export interface PageDetail {
  title: string;
  url: string;
  bodyHtml: string;
  bodyMarkdown: string;
  updatedAt: string | null;
}

/**
 * Fetches a single page's full body. Throws a clear error if Pages is
 * disabled for the course or the page does not exist.
 */
export async function getPage(client: CanvasClient, courseId: number, pageUrl: string): Promise<PageDetail> {
  try {
    const p = await client.get<Page>(`/api/v1/courses/${courseId}/pages/${pageUrl}`);
    return {
      title: p.title,
      url: p.url,
      bodyHtml: p.body ?? "",
      bodyMarkdown: htmlToMarkdown(p.body),
      updatedAt: p.updated_at ?? null,
    };
  } catch (err) {
    if (err instanceof CanvasApiError && (err.status === 403 || err.status === 404)) {
      throw new Error(
        `Page "${pageUrl}" not found in course ${courseId} (Pages may be disabled for this course, or the url is wrong).`,
      );
    }
    throw err;
  }
}
