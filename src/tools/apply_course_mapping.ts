import { join } from "node:path";
import { z } from "zod";
import { currentSemesterOf, listCourses } from "../canvas/courses.js";
import { semesterDir } from "../config.js";
import { applyMapping, proposeMapping } from "../sync/mapping.js";
import { defineTool } from "./_types.js";
import { listExistingFolders } from "./propose_course_mapping.js";

/** applyMapping's log lines (src/sync/mapping.ts, not owned here) name folders relative to the
 * semester dir — rewrite them to absolute paths so the user can see exactly what changed on disk
 * without mentally joining paths together. */
function toAbsoluteLogLine(line: string, absDir: string): string {
  let m: RegExpExecArray | null;
  if ((m = /^renamed: (.+) -> (.+)$/.exec(line))) {
    return `renamed: ${join(absDir, m[1]!)} -> ${join(absDir, m[2]!)}`;
  }
  if ((m = /^exists: (.+) \(already present, left as-is\)$/.exec(line))) {
    return `exists: ${join(absDir, m[1]!)} (already present, left as-is)`;
  }
  if ((m = /^created: (.+)\/(.+)$/.exec(line))) {
    return `created: ${join(absDir, m[2]!)}`;
  }
  if ((m = /^kept: (.+)$/.exec(line))) {
    return `kept: ${join(absDir, m[1]!)}`;
  }
  if ((m = /^unmatched folders left untouched: (.+)$/.exec(line))) {
    const folders = m[1]!.split(", ").map((f) => join(absDir, f));
    return `unmatched folders left untouched: ${folders.join(", ")}`;
  }
  return line;
}

export const tool = defineTool({
  name: "apply_course_mapping",
  description:
    "Applies the course-folder mapping: renames/creates folders ON DISK under onn <semester>/ (never deletes) " +
    "and writes config/courses.json. Re-derives the proposal fresh from live Canvas + disk state, so a stale " +
    "plan can never be applied by accident. Pass the SAME semester and overrides you passed to " +
    "propose_course_mapping — this tool re-derives the plan from them. Requires confirm: true.",
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
    confirm: z.boolean().describe("Must be true — this renames folders and writes config/courses.json."),
  },
  handler: async (input, ctx) => {
    if (input.confirm !== true) {
      throw new Error(
        "Refusing to apply without confirmation. Review propose_course_mapping's output, then call again with confirm: true."
      );
    }

    const courses = await listCourses(ctx.client);
    const semester = input.semester ?? currentSemesterOf(courses);
    if (semester === null) {
      throw new Error("Could not determine the current semester from Canvas courses; pass `semester` explicitly.");
    }

    const dir = semesterDir(semester, ctx.config);
    const existingFolders = listExistingFolders(dir);
    const proposal = proposeMapping(courses, semester, existingFolders, input.overrides);

    const log = await applyMapping(proposal, { schoolRoot: ctx.config.schoolRoot });
    return [`Applied mapping for ${dir}:`, ...log.map((l) => `- ${toAbsoluteLogLine(l, dir)}`)].join("\n");
  },
});
