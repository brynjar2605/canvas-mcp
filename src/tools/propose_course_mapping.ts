import { readdirSync } from "node:fs";
import { z } from "zod";
import { currentSemesterOf, listCourses } from "../canvas/courses.js";
import { semesterDir } from "../config.js";
import { proposeMapping, type MappingProposal } from "../sync/mapping.js";
import { defineTool } from "./_types.js";

/** Subdirectory names directly under a semester dir (e.g. "onn 5/"). Empty if the dir doesn't exist yet. */
export function listExistingFolders(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Renders a MappingProposal as a plain-text table, used by both this tool and the CLI. */
export function formatProposal(proposal: MappingProposal): string {
  const header = ["slug", "code", "name", "existing folder", "action"];
  const rows = proposal.entries.map((e) => [e.slug, e.code, e.name, e.existingFolder ?? "(none)", e.action]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmtRow = (r: string[]): string => r.map((c, i) => c.padEnd(widths[i]!)).join("  ");

  const lines: string[] = [`Mapping proposal for ${proposal.semesterDir}:`, "", fmtRow(header), widths.map((w) => "-".repeat(w)).join("  ")];
  for (const r of rows) lines.push(fmtRow(r));

  if (proposal.unmatchedFolders.length > 0) {
    lines.push("");
    lines.push(`Unmatched existing folders (left as-is): ${proposal.unmatchedFolders.join(", ")}`);
    lines.push(`Fill gaps with overrides: { "<existing-folder>": "<slug>" }, then re-propose.`);
  }

  return lines.join("\n");
}

export const tool = defineTool({
  name: "propose_course_mapping",
  description:
    "Proposes a mapping from this semester's Canvas courses to on-disk course folders (rename/create plan), without applying anything. Review this, then confirm with apply_course_mapping.",
  inputSchema: {
    semester: z
      .number()
      .int()
      .optional()
      .describe("Semester (önn) number; defaults to the current (highest-derived) semester"),
    overrides: z
      .record(z.string(), z.string())
      .optional()
      .describe('Explicit existing-folder -> slug overrides, e.g. { "compilers": "thyd" }'),
  },
  handler: async (input, ctx) => {
    const courses = await listCourses(ctx.client);
    const semester = input.semester ?? currentSemesterOf(courses);
    if (semester === null) {
      throw new Error("Could not determine the current semester from Canvas courses; pass `semester` explicitly.");
    }
    const dir = semesterDir(semester, ctx.config);
    const existingFolders = listExistingFolders(dir);
    const proposal = proposeMapping(courses, semester, existingFolders, input.overrides);
    return formatProposal(proposal);
  },
});
