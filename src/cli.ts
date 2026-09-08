#!/usr/bin/env node
// canvas-mcp CLI — thin process.argv wrapper around the same tool handlers
// the MCP server registers, so output is identical either way.
//
//   canvas-mcp courses
//   canvas-mcp mapping [--semester N] [--apply] [--override old=slug ...]
//   canvas-mcp sync <slug|all> [--dry-run]
//   canvas-mcp status [slug]

import { createClient } from "./canvas/client.js";
import { getConfig } from "./config.js";
import { tool as applyCourseMappingTool } from "./tools/apply_course_mapping.js";
import { tool as listCoursesTool } from "./tools/list_courses.js";
import { tool as proposeCourseMappingTool } from "./tools/propose_course_mapping.js";
import { tool as syncCourseTool } from "./tools/sync_course.js";
import { tool as syncStatusTool } from "./tools/sync_status.js";
import type { ToolContext } from "./tools/_types.js";

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
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags, overrides };
}

function usage(): string {
  return [
    "Usage: canvas-mcp <command> [options]",
    "",
    "  canvas-mcp courses",
    "  canvas-mcp mapping [--semester N] [--apply] [--override old=slug ...]",
    "  canvas-mcp sync <slug|all> [--dry-run]",
    "  canvas-mcp status [slug]",
  ].join("\n");
}

async function run(argv: string[]): Promise<string> {
  const [cmd, ...rest] = argv;
  const ctx: ToolContext = { client: createClient(), config: getConfig() };

  switch (cmd) {
    case "courses": {
      return listCoursesTool.handler({ include_past: false }, ctx);
    }

    case "mapping": {
      const { flags, overrides } = parseArgs(rest);
      const semester = typeof flags.semester === "string" && flags.semester.length > 0 ? Number(flags.semester) : undefined;
      const overridesArg = Object.keys(overrides).length > 0 ? overrides : undefined;

      if (flags.apply) {
        return applyCourseMappingTool.handler({ semester, overrides: overridesArg, confirm: true }, ctx);
      }
      return proposeCourseMappingTool.handler({ semester, overrides: overridesArg }, ctx);
    }

    case "sync": {
      const { positional, flags } = parseArgs(rest);
      const target = positional[0];
      if (!target) {
        throw new Error("Usage: canvas-mcp sync <slug|all> [--dry-run]");
      }
      return syncCourseTool.handler({ course: target, dry_run: Boolean(flags.dryRun) }, ctx);
    }

    case "status": {
      const { positional } = parseArgs(rest);
      return syncStatusTool.handler({ course: positional[0] }, ctx);
    }

    default:
      if (cmd) {
        throw new Error(`Unknown command "${cmd}".\n\n${usage()}`);
      }
      return usage();
  }
}

run(process.argv.slice(2))
  .then((output) => {
    console.log(output);
  })
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  });
