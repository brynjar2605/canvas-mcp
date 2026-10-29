import { existsSync, readdirSync } from "node:fs";
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

/**
 * Renders a MappingProposal as markdown: the absolute semester directory up
 * top (the user is approving a filesystem mutation, so which directory tree
 * matters), an explicit from -> to plan per course including a note on
 * case-only renames (done via a temp name, since some filesystems treat
 * "POSH" and "posh" as the same path), and a ready-to-run override suggestion
 * for any folder no course claimed.
 */
export function formatProposal(proposal: MappingProposal, absoluteDir: string, dirExists: boolean): string {
  const lines: string[] = [`Mapping proposal for ${absoluteDir}`, ""];

  if (!dirExists) {
    lines.push(`Note: ${absoluteDir} does not exist yet — it will be created.`, "");
  }

  lines.push("| slug | code | name | plan |", "| --- | --- | --- | --- |");
  for (const e of proposal.entries) {
    let plan: string;
    if (e.action === "create") {
      plan = `create \`${e.slug}/\``;
    } else if (e.action === "keep") {
      plan = `keep \`${e.slug}/\``;
    } else {
      const caseOnly = e.existingFolder !== null && e.existingFolder.toLowerCase() === e.slug.toLowerCase();
      const caseNote = caseOnly ? " (case-only; done via a temp name, safe on macOS)" : "";
      plan = `rename \`${e.existingFolder}/\` → \`${e.slug}/\`${caseNote}`;
    }
    lines.push(`| ${e.slug} | ${e.code} | ${e.name} | ${plan} |`);
  }

  if (proposal.unmatchedFolders.length > 0) {
    const example = proposal.unmatchedFolders[0]!;
    lines.push(
      "",
      `Folders no course claimed (will be left untouched): ${proposal.unmatchedFolders.map((f) => `\`${f}\``).join(", ")}`,
      "If one of these is actually a course folder under a different name, re-run with overrides, e.g.:",
      `  propose_course_mapping({ overrides: { "${example}": "<slug>" } })`,
      "then apply_course_mapping with the same overrides.",
    );
  }

  lines.push(
    "",
    "Nothing has been changed. Renames never delete anything; existing folders are only renamed, and files already inside them are preserved.",
  );

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
      .describe("Semester (önn) number; defaults to the current semester (the term in progress today, by Canvas term dates)"),
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
    const dirExists = existsSync(dir);
    const existingFolders = listExistingFolders(dir);
    const proposal = proposeMapping(courses, semester, existingFolders, input.overrides);
    return formatProposal(proposal, dir, dirExists);
  },
});
