import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SparkMemoryStore } from "@zendev-lab/spark-memory";
import * as z from "zod/v4";

export interface SparkMemoryMcpServerOptions {
  name?: string;
  version?: string;
  store: SparkMemoryStore;
  /** Max entries returned by spark_memory_list (hard cap 100). */
  listLimit?: number;
}

/**
 * Minimal MCP server that exposes read-only Spark memory status/list tools.
 *
 * Intended for opt-in interop (Cursor / Claude Desktop / etc.). Does not start
 * with the daemon; call `connect(transport)` from an experimental entrypoint.
 */
export function createSparkMemoryMcpServer(options: SparkMemoryMcpServerOptions): McpServer {
  const store = options.store;
  const listLimit = Math.min(Math.max(options.listLimit ?? 50, 1), 100);
  const server = new McpServer({
    name: options.name ?? "spark-mcp-spike",
    version: options.version ?? "0.1.0",
  });

  server.registerTool(
    "spark_memory_status",
    {
      description:
        "Read-only Spark memory store status (path + active/forgotten counts by category).",
      inputSchema: {},
    },
    async () => {
      const summary = await store.status();
      const text = JSON.stringify(summary, null, 2);
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: summary as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "spark_memory_list",
    {
      description: "List active Spark memory entries (read-only; truncated).",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe(`Max entries to return (default ${listLimit}, max 100).`),
        includeForgotten: z.boolean().optional().describe("When true, include forgotten entries."),
      },
    },
    async ({ limit, includeForgotten }) => {
      const entries = await store.list({ includeForgotten: includeForgotten ?? false });
      const capped = entries.slice(0, limit ?? listLimit).map((entry) => ({
        id: entry.id,
        scope: entry.scope,
        category: entry.category,
        text: entry.text,
        tags: entry.tags,
        status: entry.status,
        updatedAt: entry.updatedAt,
      }));
      const payload = {
        storePath: store.filePath,
        total: entries.length,
        returned: capped.length,
        entries: capped,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}
