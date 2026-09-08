import type { CanvasClient } from "./client.js";
import type { Module, ModuleItem } from "./types.js";

/** Canvas's modules/items endpoint includes an `indent` field not in types.ts. */
interface RawModuleItem extends ModuleItem {
  indent?: number;
}

export interface ModuleItemInfo {
  id: number;
  title: string;
  /** "File" | "Page" | "Assignment" | "ExternalUrl" | "SubHeader" | "Quiz" | "Discussion" | ... */
  type: string;
  contentId: number | null;
  pageUrl: string | null;
  externalUrl: string | null;
  htmlUrl: string | null;
  indent: number;
}

export interface ModuleInfo {
  id: number;
  name: string;
  position: number;
  items: ModuleItemInfo[];
}

const MODULES_TTL_MS = 10 * 60 * 1000;

function toItemInfo(item: RawModuleItem): ModuleItemInfo {
  return {
    id: item.id,
    title: item.title,
    type: item.type,
    contentId: item.content_id ?? null,
    pageUrl: item.page_url ?? null,
    externalUrl: item.external_url ?? null,
    htmlUrl: item.html_url ?? null,
    indent: item.indent ?? 0,
  };
}

/**
 * All modules in a course, with items. Canvas omits `items` from the
 * `?include[]=items` response for modules that have "too many" items
 * (undocumented threshold) — when that happens we fetch that module's
 * items from the dedicated `/modules/:id/items` endpoint instead.
 */
export async function listModules(client: CanvasClient, courseId: number): Promise<ModuleInfo[]> {
  const modules = await client.getAll<Module>(
    `/api/v1/courses/${courseId}/modules`,
    { "include[]": ["items", "content_details"] },
    MODULES_TTL_MS
  );

  const results: ModuleInfo[] = [];
  for (const mod of modules) {
    let items: RawModuleItem[] | undefined = mod.items;
    if (!items) {
      items = await client.getAll<RawModuleItem>(
        `/api/v1/courses/${courseId}/modules/${mod.id}/items`,
        undefined,
        MODULES_TTL_MS
      );
    }
    results.push({
      id: mod.id,
      name: mod.name,
      position: mod.position,
      items: items.map(toItemInfo),
    });
  }
  return results;
}
