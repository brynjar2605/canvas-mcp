#!/usr/bin/env node
// canvas-mcp server entry point (stdio transport).
// Builds the ToolContext once, registers every tool from the registry, and
// wires MCP SDK error handling around each handler. No business logic lives
// here — see src/tools/*.ts.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CanvasAuthError } from "./canvas/client.js";
import { createClient } from "./canvas/client.js";
import { ConfigError, getConfig } from "./config.js";
import { allTools } from "./tools/_registry.js";
import type { ToolContext } from "./tools/_types.js";

/**
 * Builds the MCP server and registers every tool in `allTools` against it.
 * Pass a `ctx` to inject a fake CanvasClient/Config for testing without
 * touching the filesystem, environment, or network; omit it to build the
 * real context from `.env` (throws `ConfigError` if required vars are missing).
 */
export function createServer(ctx?: ToolContext): McpServer {
  const context: ToolContext = ctx ?? { client: createClient(), config: getConfig() };

  const server = new McpServer({
    name: "canvas",
    version: "0.1.0",
  });

  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (input: Record<string, unknown>) => {
        try {
          const text = await tool.handler(input, context);
          return { content: [{ type: "text" as const, text }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const needsEnvHint = err instanceof CanvasAuthError || err instanceof ConfigError;
          const hint = needsEnvHint
            ? " Check your .env file (CANVAS_TOKEN, CANVAS_BASE_URL, SCHOOL_ROOT, CURRENT_SEMESTER)."
            : "";
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Error: ${message}${hint}` }],
          };
        }
      },
    );
  }

  return server;
}

async function main(): Promise<void> {
  let server: McpServer;
  try {
    server = createServer();
  } catch (err) {
    if (err instanceof ConfigError) {
      // stdout is reserved for the MCP transport — configuration errors go to stderr.
      console.error(`canvas-mcp: configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("canvas-mcp: connected (stdio)");
}

main().catch((err) => {
  console.error("canvas-mcp: fatal error", err);
  process.exit(1);
});
