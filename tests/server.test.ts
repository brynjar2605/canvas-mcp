import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { CanvasClient } from "../src/canvas/client.js";
import type { Config } from "../src/config.js";
import { createServer } from "../src/index.js";
import { allTools } from "../src/tools/_registry.js";

const EXPECTED_TOOL_NAMES = [
  "list_courses",
  "list_assignments",
  "get_assignment",
  "get_upcoming",
  "list_announcements",
  "get_grades",
  "get_page",
  "list_modules",
  "download_file",
  "propose_course_mapping",
  "apply_course_mapping",
  "sync_course",
  "sync_status",
  "search_materials",
];

function fakeCtx() {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
  const config: Config = {
    baseUrl: "https://x.test",
    token: "t",
    schoolRoot: "/tmp/canvas-mcp-test",
    currentSemester: 5,
  };
  const client = new CanvasClient(config, { fetchImpl, sleep: async () => {} });
  return { client, config };
}

describe("allTools registry", () => {
  it("lists exactly the 14 planned tools, each with a description and a zod shape", () => {
    expect(allTools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
    for (const t of allTools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(typeof t.inputSchema).toBe("object");
      expect(t.inputSchema).not.toBeNull();
    }
  });

  it("has no duplicate tool names", () => {
    const names = allTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("createServer over an in-memory MCP transport", () => {
  let client: Client;

  beforeAll(async () => {
    const server = createServer(fakeCtx());
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: "test-client", version: "0.0.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  it("exposes all 14 tools via tools/list", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it("every listed tool has a non-empty description", async () => {
    const result = await client.listTools();
    for (const t of result.tools) {
      expect(t.description, `${t.name} should have a description`).toBeTruthy();
    }
  });
});
