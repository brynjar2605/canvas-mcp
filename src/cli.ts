#!/usr/bin/env node
// canvas-mcp CLI — thin process.argv wrapper around the same tool handlers
// the MCP server registers, so output is identical either way. Arguments are
// validated through each tool's own zod schema before dispatch, so e.g.
// `--semester abc` fails with a clear message instead of silently becoming NaN.
//
//   canvas-mcp courses [--include-past]
//   canvas-mcp mapping [--semester N] [--apply] [--override old=slug ...]
//   canvas-mcp sync <slug|all> [--dry-run]
//   canvas-mcp status [slug]
//   canvas-mcp help | --help | -h

import { z } from "zod";
import { createClient } from "./canvas/client.js";
import { getConfig } from "./config.js";
import { tool as applyCourseMappingTool } from "./tools/apply_course_mapping.js";
import { tool as listCoursesTool } from "./tools/list_courses.js";
import { tool as proposeCourseMappingTool } from "./tools/propose_course_mapping.js";
import { tool as syncCourseTool } from "./tools/sync_course.js";
import { tool as syncStatusTool } from "./tools/sync_status.js";
import type { ToolContext } from "./tools/_types.js";
import type { ToolDef } from "./tools/_types.js";

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
  overrides: Record<string, string>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const overrides: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--dry-run") {
      flags.dryRun = true;
    } else if (arg === "--apply") {
      flags.apply = true;
    } else if (arg === "--include-past") {
      flags.includePast = true;
    } else if (arg === "--semester") {
      flags.semester = args[++i] ?? "";
    } else if (arg === "--override") {
      const pair = args[++i] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) {
        throw new Error(`Invalid --override value "${pair}", expected old=slug`);
      }
      overrides[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}\n\n${usage()}`);
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags, overrides };
}

/** Validates `raw` against a tool's own zod input schema, so CLI args get exactly the same
 * validation an MCP tool call would (clear per-field messages, no silent NaN/undefined coercion). */
function validateInput<S extends z.ZodRawShape>(tool: ToolDef<S>, raw: Record<string, unknown>): z.infer<z.ZodObject<S>> {
  const result = z.object(tool.inputSchema).safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(argument)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid arguments for "${tool.name}" — ${issues}`);
  }
  return result.data;
}

export function usage(): string {
  return [
    "Usage: canvas-mcp <command> [options]",
    "",
    "  canvas-mcp courses [--include-past]        List your courses.",
    "  canvas-mcp mapping [--semester N] [--apply] [--override old=slug ...]",
    "                                              Propose (or, with --apply, apply) the",
    "                                              Canvas-course -> local-folder mapping.",
    "  canvas-mcp sync <slug|all> [--dry-run]     Download new/changed course material.",
    "  canvas-mcp status [slug]                   Show sync status for one or all courses.",
    "  canvas-mcp help | --help | -h              Show this message.",
  ].join("\n");
}

export async function run(argv: string[]): Promise<string> {
  const [cmd, ...rest] = argv;
  const ctx: ToolContext = { client: createClient(), config: getConfig() };

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return usage();

    case "courses": {
      const { flags } = parseArgs(rest);
      const input = validateInput(listCoursesTool, { include_past: Boolean(flags.includePast) });
      return listCoursesTool.handler(input, ctx);
    }

    case "mapping": {
      const { flags, overrides } = parseArgs(rest);
      const semesterRaw = typeof flags.semester === "string" && flags.semester.length > 0 ? Number(flags.semester) : undefined;
      const overridesArg = Object.keys(overrides).length > 0 ? overrides : undefined;

      if (flags.apply) {
        const input = validateInput(applyCourseMappingTool, { semester: semesterRaw, overrides: overridesArg, confirm: true });
        return applyCourseMappingTool.handler(input, ctx);
      }
      const input = validateInput(proposeCourseMappingTool, { semester: semesterRaw, overrides: overridesArg });
      return proposeCourseMappingTool.handler(input, ctx);
    }

    case "sync": {
      const { positional, flags } = parseArgs(rest);
      const target = positional[0];
      if (!target) {
        throw new Error(`Usage: canvas-mcp sync <slug|all> [--dry-run]`);
      }
      const input = validateInput(syncCourseTool, { course: target, dry_run: Boolean(flags.dryRun) });
      return syncCourseTool.handler(input, ctx);
    }

    case "status": {
      const { positional } = parseArgs(rest);
      const input = validateInput(syncStatusTool, { course: positional[0] });
      return syncStatusTool.handler(input, ctx);
    }

    default:
      throw new Error(`Unknown command "${cmd}".\n\n${usage()}`);
  }
}

// Only auto-run when this file is the actual process entry point (`node dist/cli.js ...` /
// the `canvas-mcp` bin) — not when imported as a module (e.g. by tests), which would otherwise
// eagerly call getConfig()/createClient() and exit the process out from under the test runner.
const isMainModule = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  run(process.argv.slice(2))
    .then((output) => {
      console.log(output);
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exit(1);
    });
}
