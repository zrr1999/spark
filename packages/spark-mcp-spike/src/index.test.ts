import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
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

  it("connects, lists tools, and calls a tool over stateless Streamable HTTP", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-mcp-spike-http-"));
    tempDirs.push(dir);
    const storePath = join(dir, "memory.json");
    await writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        entries: [],
      }),
      "utf8",
    );

    const store = new SparkMemoryStore(storePath);
    const activeMcpServers = new Set<{
      server: ReturnType<typeof createSparkMemoryMcpServer>;
      transport: StreamableHTTPServerTransport;
    }>();
    const observedServerSessionIds: Array<string | undefined> = [];

    const httpServer = createServer((request, response) => {
      void (async () => {
        const server = createSparkMemoryMcpServer({ store });
        // SDK 1.29's declarations were emitted without exactOptionalPropertyTypes;
        // `undefined` is its documented explicit stateless mode.
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        } as unknown as StreamableHTTPServerTransportOptions);
        const active = { server, transport };
        activeMcpServers.add(active);
        const closeMcpServer = async () => {
          if (!activeMcpServers.delete(active)) return;
          await Promise.all([transport.close(), server.close()]);
        };
        response.once("close", () => {
          void closeMcpServer().catch(() => undefined);
        });

        try {
          await server.connect(asSdkTransport(transport));
          observedServerSessionIds.push(transport.sessionId);
          await transport.handleRequest(request, response);
        } catch (error: unknown) {
          await closeMcpServer();
          if (!response.headersSent) {
            response
              .writeHead(500)
              .end(error instanceof Error ? error.message : "MCP transport error");
          }
        }
      })();
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => {
        httpServer.off("error", reject);
        resolve();
      });
    });

    const address = httpServer.address() as AddressInfo;
    const client = new Client({ name: "spark-mcp-spike-http-test", version: "0.0.0" });
    const clientTransport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
    );

    try {
      await client.connect(asSdkTransport(clientTransport));
      expect(clientTransport.sessionId).toBeUndefined();

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "spark_memory_list",
        "spark_memory_status",
      ]);

      const status = await client.callTool({ name: "spark_memory_status", arguments: {} });
      expect(status.isError).toBeFalsy();
      expect(textContent(status)).toContain(storePath);
      expect(observedServerSessionIds.length).toBeGreaterThanOrEqual(3);
      expect(observedServerSessionIds.every((sessionId) => sessionId === undefined)).toBe(true);
    } finally {
      await client.close();
      await Promise.all(
        [...activeMcpServers].map(async ({ server, transport }) => {
          await Promise.all([transport.close(), server.close()]);
        }),
      );
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

function asSdkTransport(
  transport: StreamableHTTPServerTransport | StreamableHTTPClientTransport,
): Transport {
  // SDK 1.29's concrete transports and Transport interface disagree only on
  // exact-optional declarations. Keep the compatibility bridge inside this canary.
  return transport as unknown as Transport;
}

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
