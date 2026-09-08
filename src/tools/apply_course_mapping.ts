import { z } from "zod";
import { currentSemesterOf, listCourses } from "../canvas/courses.js";
import { semesterDir } from "../config.js";
import { applyMapping, proposeMapping } from "../sync/mapping.js";
import { defineTool } from "./_types.js";
import { listExistingFolders } from "./propose_course_mapping.js";

export const tool = defineTool({
  name: "apply_course_mapping",
  description:
    "Applies the course-folder mapping: renames/creates folders under onn <semester>/ (never deletes) and writes config/courses.json. Re-derives the proposal fresh from live Canvas + disk state, so a stale plan can never be applied by accident. Requires confirm: true.",
  inputSchema: {
    semester: z.number().int().optional(),
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
    return [`Applied mapping for ${proposal.semesterDir}:`, ...log.map((l) => `- ${l}`)].join("\n");
  },
});
