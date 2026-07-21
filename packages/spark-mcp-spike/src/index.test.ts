import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SparkMemoryStore } from "@zendev-lab/spark-memory";
import { afterEach, describe, expect, it } from "vitest";

import { createSparkMemoryMcpServer } from "./index.ts";

describe("spark-mcp-spike", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("exposes memory status and list tools over an in-memory MCP transport", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-mcp-spike-"));
    tempDirs.push(dir);
    const storePath = join(dir, "memory.json");
    await writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: "memory:test-1",
            scope: "workspace",
            category: "insight",
            text: "prefer small ACP/MCP spikes",
            reason: "phase-6",
            evidenceRefs: [],
            tags: ["spike"],
            status: "active",
            createdAt: "2026-07-21T00:00:00.000Z",
            updatedAt: "2026-07-21T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );

    const store = new SparkMemoryStore(storePath);
    const server = createSparkMemoryMcpServer({ store });
    const client = new Client({ name: "spark-mcp-spike-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "spark_memory_list",
        "spark_memory_status",
      ]);

      const status = await client.callTool({ name: "spark_memory_status", arguments: {} });
      expect(status.isError).toBeFalsy();
      const statusText = textContent(status);
      expect(statusText).toContain(storePath);
      expect(statusText).toContain('"active": 1');

      const listed = await client.callTool({
        name: "spark_memory_list",
        arguments: { limit: 10 },
      });
      expect(listed.isError).toBeFalsy();
      const listedText = textContent(listed);
      expect(listedText).toContain("prefer small ACP/MCP spikes");
      expect(listedText).toContain("memory:test-1");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

function textContent(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const block = content.find(
    (item): item is { type: string; text?: string } =>
      !!item && typeof item === "object" && (item as { type?: unknown }).type === "text",
  );
  return typeof block?.text === "string" ? block.text : "";
}
