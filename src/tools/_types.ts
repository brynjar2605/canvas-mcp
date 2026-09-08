import type { z } from "zod";
import type { CanvasClient } from "../canvas/client.js";
import type { Config } from "../config.js";

/** Passed to every tool handler. Built once in src/index.ts. */
export interface ToolContext {
  client: CanvasClient;
  config: Config;
}

/**
 * Every file in src/tools/<name>.ts exports `export const tool = defineTool({...})`.
 * `inputSchema` is a zod raw shape (the object passed to z.object()), which is what the
 * MCP SDK's registerTool expects. Handlers return LLM-friendly text (markdown), not raw JSON dumps.
 * Throw a plain Error with a helpful message for user-facing failures; index.ts converts it to an
 * MCP error result.
 */
export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: S;
  handler: (input: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<string>;
}

export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}
