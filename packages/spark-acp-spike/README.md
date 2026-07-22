# spark-acp-spike

Experimental [Agent Client Protocol](https://agentclientprotocol.com) agent stub using the official `@agentclientprotocol/sdk`.

**Not wired into spark-daemon default startup.** See [docs/operations/acp-spike.md](../../docs/operations/acp-spike.md).

## Commands

```bash
pnpm --filter @zendev-lab/spark-acp-spike test
pnpm --filter @zendev-lab/spark-acp-spike run stdio   # optional NDJSON stdio agent
```
