# Spark TUI Native Practical Pi-Parity Matrix

Spark TUI remains daemon-first and does not runtime-depend on `@earendil-works/pi-coding-agent`. The rows below summarize the practical native coverage added for the foreground parity goal.

| Pi feature surface | Spark-native coverage | Evidence |
| --- | --- | --- |
| Core file tools | `@zendev-lab/spark-files` provides read/write/edit/ls/grep/find without importing Spark packages or `pi-coding-agent`. | `artifact:0674094c-39c5-4763-a25c-7b03b6ee9048`, `artifact:4fccd6b2-1960-4647-8fe7-fdd761e71a86` |
| Model registry/models command | Spark host model registry adapter exposes provider/model state to `pi-models`; native `/model` picker remains Spark-owned. | `artifact:0b7a5065-068b-4954-80d3-951bcdfa927a` |
| Provider auth/OAuth | Spark auth store/resolver supports OAuth/local credentials and login/logout commands without upstream runtime dependency. | `artifact:4a6b6048-fb8c-4437-ad53-eeb32502db84` |
| Theme, markdown, diff rendering | Spark theme catalog, Markdown bridge, diff/role styling, and persisted `/settings set theme` support native TUI rendering parity. | `artifact:3adfada2-921f-4012-886c-061aa8466663`, `artifact:15fb9e7b-7b34-490b-9f0f-58c3b7087739` |
| Compaction and branch summaries | `/compact` persists real compaction entries and rewrites visible context; `/tree ... summarize` appends branch summary entries. | `artifact:e2d2e583-b816-4a2a-bdd5-a487e29e8e51` |
| Prompt templates | Spark loads `~/.spark/prompts`, workspace `.spark/prompts`, and configured paths; registers non-colliding slash templates with Pi-style argument expansion, disabled/malformed diagnostics. | `artifact:05afc671-836e-4892-92cc-8dce569cde17` |
| HTML export/share | `/export html` and `/share` write self-contained, theme-aware, escaped local HTML for visible or persisted sessions; no secret upload by default. | `artifact:2914e9af-edee-4144-8e25-c59616f73e9f` |
| Package manager resources | `install/remove/update/list/config` manage local/npm/git resources in Spark package roots with manifest/config reconciliation and safe deletion boundaries. | `artifact:89377550-a259-4fd4-819d-0cd7c015dea6` |
| Image paste/resize content | `@image` and pasted/dragged image paths become bounded structured `<image>` attachments with MIME/size/dimension metadata; oversized images are rejected with diagnostics and transcript rendering elides base64. | `artifact:f67723ad-fac1-4251-886c-c1adfe68e6e6` |
| JSON/RPC/SDK CLI | `--print`, `--mode json`, `--mode rpc`, and native TUI turns all use daemon IPC. RPC prompt/get_state use daemon services; get_messages/abort/new_session remain compatibility placeholders for queued daemon turns. No separate in-process direct mode is exposed. | final task validation artifact |

## Boundary checks

- No `apps/spark-tui` implementation imports `@earendil-works/pi-coding-agent` at runtime.
- `pi-*` packages stay reusable and do not import `spark-*`; Spark app/host glue owns Spark-specific adapters.
- Shell access remains through the Spark/Cue surfaces; no `bash` tool was introduced.
- Cockpit/workflow/session behavior is daemon-first; Spark CLI does not expose a separate direct execution mode.
