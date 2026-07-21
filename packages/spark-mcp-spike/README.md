# spark-mcp-spike

Experimental [Model Context Protocol](https://modelcontextprotocol.io) server that exposes read-only Spark memory tools (`spark_memory_status`, `spark_memory_list`) via `@modelcontextprotocol/sdk`.

**Not enabled by default.** Opt-in stdio entry only.

## Commands

```bash
pnpm --filter @zendev-lab/spark-mcp-spike test
SPARK_MCP_SPIKE_MEMORY_FILE=.spark/memory/memory.json \
  pnpm --filter @zendev-lab/spark-mcp-spike run stdio
```
