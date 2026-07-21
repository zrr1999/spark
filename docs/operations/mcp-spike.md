# MCP spike (memory tools)

Status: **experimental / not default-enabled**. Official SDK: [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) `1.29.0`.

Package: [`packages/spark-mcp-spike`](../../packages/spark-mcp-spike/).

## Goal

Expose one existing Spark capability as MCP tools so external MCP clients can read workspace memory without embedding Spark host code.

## Tools (read-only)

| Tool | Behavior |
| --- | --- |
| `spark_memory_status` | `SparkMemoryStore.status()` |
| `spark_memory_list` | `SparkMemoryStore.list()` (truncated) |

Smoke: `pnpm --filter @zendev-lab/spark-mcp-spike test`.

Optional stdio:

```bash
SPARK_MCP_SPIKE_MEMORY_FILE=.spark/memory/memory.json \
  pnpm --filter @zendev-lab/spark-mcp-spike run stdio
```

## Non-goals

- Not started by spark-daemon / CLI by default.
- No write/forget/search tools in this spike (keep the blast radius read-only).
- No publish (`private` package).
