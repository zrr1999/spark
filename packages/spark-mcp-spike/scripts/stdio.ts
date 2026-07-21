#!/usr/bin/env node
/**
 * Optional stdio MCP server entry for manual client smoke tests.
 * Not registered in spark-daemon / CLI default paths.
 *
 *   SPARK_MCP_SPIKE_MEMORY_FILE=/path/to/memory.json \
 *     pnpm --filter @zendev-lab/spark-mcp-spike run stdio
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SparkMemoryStore, sparkMemoryStorePath } from "@zendev-lab/spark-memory";

import { createSparkMemoryMcpServer } from "../src/index.ts";

const cwd = process.cwd();
const filePath =
  process.env.SPARK_MCP_SPIKE_MEMORY_FILE?.trim() || sparkMemoryStorePath(cwd, "workspace");
const store = new SparkMemoryStore(filePath);
const server = createSparkMemoryMcpServer({ store });
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[spark-mcp-spike] stdio server ready (memory=${filePath})`);
