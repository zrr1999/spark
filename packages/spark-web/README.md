# @zendev-lab/spark-web

Native Spark web capability package.

It registers the public network tool names expected by Spark roles and workflow adapters:

- `web_search`
- `fetch_content`
- `get_search_content`

The package is conservative by default:

- URL fetches run SSRF checks before network access.
- Retrieved page text is wrapped as untrusted web content so prompt-injection text is not treated as instructions.
- Provider keys are read from environment/config but never echoed in tool output.
- Content is cached under `.spark/web/content.json` and can be recovered with `get_search_content`.
- If a Pi host already registered the same tool name (for example through `pi-web-access`), registration skips by default rather than replacing it.

Search provider support starts with Brave Search via `BRAVE_API_KEY`; tests and hosts can inject a deterministic provider.
