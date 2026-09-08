#!/usr/bin/env node
// canvas-mcp server entry point (stdio transport).
// Phase 1 stub: wires up the MCP SDK with a single `ping` tool so
// `npm run dev` can prove the transport works end-to-end. Phase 2 replaces
// this with the real tool registrations from PLAN.md.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
  name: "canvas",
  version: "0.1.0",
});

server.registerTool(
  "ping",
  {
    title: "Ping",
    description: "Health check tool — returns 'pong'. Used to verify MCP wiring.",
    inputSchema: {},
  },
  async () => {
    return {
      content: [{ type: "text", text: "pong" }],
    };
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is reserved for the MCP transport; log startup info to stderr.
  console.error("canvas-mcp: connected (stdio)");
}

main().catch((err) => {
  console.error("canvas-mcp: fatal error", err);
  process.exit(1);
});
