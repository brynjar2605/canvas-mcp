import TurndownService from "turndown";

// Turndown's Node type resolves against DOM lib types that this project does
// not include (tsconfig `lib` is ES2022 only). With `skipLibCheck: true` the
// unresolvable type collapses harmlessly, but we still avoid writing the bare
// type name ourselves and instead alias it to `any` for clarity at call sites.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;

function isTrackingImage(node: AnyNode): boolean {
  const width = node.getAttribute?.("width");
  const height = node.getAttribute?.("height");
  const src = String(node.getAttribute?.("src") ?? "");
  const isTiny = (v: string | null) => v === "0" || v === "1";
  if (isTiny(width) && isTiny(height)) return true;
  if (/\b(pixel|beacon|1x1)\b/i.test(src)) return true;
  if (/\/(track|tracking)\//i.test(src)) return true;
  return false;
}

/** Escapes `|` and collapses newlines so a cell's markdown fits on one table row. */
function cellMarkdown(service: TurndownService, cell: AnyNode): string {
  const html = cell.innerHTML ?? "";
  return service
    .turndown(html)
    .replace(/\|/g, "\\|")
    .replace(/\r?\n+/g, " ")
    .trim();
}

let cachedService: TurndownService | null = null;

function getService(): TurndownService {
  if (cachedService) return cachedService;

  const service = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    linkStyle: "inlined",
  });

  // Canvas rich-text bodies routinely embed <script>/<style> (LTI widgets,
  // equation renderers) and tracking-pixel <img>s — none of it is useful
  // markdown, so strip it outright.
  service.remove(["script", "style", "noscript"]);

  service.addRule("stripTrackingImages", {
    filter: (node: AnyNode) => node.nodeName === "IMG" && isTrackingImage(node),
    replacement: () => "",
  });

  // Turndown has no built-in table support; render a plain GFM-style table
  // ourselves ("reasonably", not pixel-perfect) so assignment/page bodies
  // with grading rubrics or schedules stay readable.
  service.addRule("table", {
    filter: "table",
    replacement: (_content: string, node: AnyNode) => {
      const rows: AnyNode[] = Array.from(node.rows ?? []);
      if (rows.length === 0) return "";
      const lines: string[] = [];
      rows.forEach((row, i) => {
        const cells: AnyNode[] = Array.from(row.cells ?? []);
        const cellsMd = cells.map((c) => cellMarkdown(service, c));
        lines.push(`| ${cellsMd.join(" | ")} |`);
        if (i === 0) {
          lines.push(`| ${cellsMd.map(() => "---").join(" | ")} |`);
        }
      });
      return `\n\n${lines.join("\n")}\n\n`;
    },
  });

  // Table internals are fully handled by the "table" rule above (it reads
  // node.rows/node.cells directly); suppress turndown's default recursion
  // into these so cell contents don't also get emitted at the top level.
  service.addRule("tableInternals", {
    filter: ["tr", "td", "th", "thead", "tbody", "tfoot", "colgroup", "col"],
    replacement: () => "",
  });

  cachedService = service;
  return service;
}

/**
 * Converts a Canvas rich-text HTML body to markdown. Strips `<script>`,
 * `<style>`, and tracking pixels; keeps links, headings, lists, and renders
 * tables as GFM-style markdown tables. Returns "" for null/undefined/empty input.
 */
export function htmlToMarkdown(html: string | null | undefined): string {
  if (!html) return "";
  const trimmed = html.trim();
  if (trimmed.length === 0) return "";
  const service = getService();
  return service.turndown(trimmed).trim();
}
