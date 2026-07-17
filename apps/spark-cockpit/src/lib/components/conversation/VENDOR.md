# Svelte AI Elements source provenance

- Upstream: <https://github.com/SikandarJODD/ai-elements>
- Upstream commit: `fa4bc217f84bc571378bc371332a154106772614`
- License: MIT; the required upstream notice is retained in `UPSTREAM-LICENSE.txt`
- Imported: 2026-07-13
- Last reviewed upstream commit: `fa4bc217f84bc571378bc371332a154106772614`

## Reviewed sources

- `src/lib/components/ai-elements/conversation/conversation.svelte`
- `src/lib/components/ai-elements/conversation/conversation-content.svelte`
- `src/lib/components/ai-elements/conversation/conversation-scroll-button.svelte`
- `src/lib/components/ai-elements/message/core/message.svelte`
- `src/lib/components/ai-elements/message/core/message-content.svelte`
- `src/lib/components/ai-elements/message/actions/message-actions.svelte`
- `src/lib/components/ai-elements/message/actions/message-action.svelte`
- `src/lib/components/ai-elements/reasoning/reasoning.svelte`
- `src/lib/components/ai-elements/reasoning/reasoning-trigger.svelte`
- `src/lib/components/ai-elements/chain-of-thought/chain-of-thought.svelte`
- `src/lib/components/ai-elements/chain-of-thought/chain-of-thought-header.svelte`
- `src/lib/components/ai-elements/chain-of-thought/chain-of-thought-content.svelte`
- `src/lib/components/ai-elements/chain-of-thought/chain-of-thought-step.svelte`
- `src/lib/components/ai-elements/tool/tool.svelte`
- `src/lib/components/ai-elements/tool/tool-header.svelte`
- `src/lib/components/ai-elements/task/task.svelte`
- `src/lib/components/ai-elements/task/task-trigger.svelte`
- `src/lib/components/ai-elements/confirmation/confirmation.svelte`
- `src/lib/components/ai-elements/prompt-input/core/root.svelte`
- `src/lib/components/ai-elements/prompt-input/layout/body.svelte`
- `src/lib/components/ai-elements/prompt-input/layout/toolbar.svelte`
- `src/lib/components/ai-elements/prompt-input/controls/textarea.svelte`
- `src/lib/components/ai-elements/prompt-input/controls/submit.svelte`
- `src/lib/components/ai-elements/queue/queue.svelte`
- `src/lib/components/ai-elements/queue/queue-section.svelte`
- `src/lib/components/ai-elements/queue/queue-section-trigger.svelte`
- `src/lib/components/ai-elements/queue/queue-section-label.svelte`
- `src/lib/components/ai-elements/queue/queue-section-content.svelte`
- `src/lib/components/ai-elements/queue/queue-list.svelte`
- `src/lib/components/ai-elements/queue/queue-item.svelte`
- `src/lib/components/ai-elements/queue/queue-item-indicator.svelte`
- `src/lib/components/ai-elements/queue/queue-item-content.svelte`
- `src/lib/components/ai-elements/queue/queue-item-description.svelte`
- `src/lib/components/ai-elements/queue/queue-item-actions.svelte`
- `src/lib/components/ai-elements/queue/queue-item-action.svelte`
- `src/lib/components/ai-elements/queue/queue-item-attachment.svelte`
- `src/lib/components/ai-elements/queue/queue-item-image.svelte`
- `src/lib/components/ai-elements/queue/queue-item-file.svelte`
- `src/lib/components/ai-elements/queue/types.ts`
- `src/lib/components/ai-elements/queue/index.ts`

## Local changes

These are source-derived Spark components, not a registry snapshot. The composition and interaction
ideas above were translated to Svelte 5 components that use Cockpit's scoped CSS and Spark tokens.

- Removed Tailwind, shadcn-svelte, Bits UI, `runed`, and AI SDK dependencies from the conversation
  shell. Markdown rendering now delegates to the separately vendored Svelte AI Elements Response
  boundary in `../response/`.
- Replaced AI SDK message, tool, file, and chat state types with Cockpit-local `ConversationPart` types.
- Kept the daemon session snapshot and SvelteKit form actions as the only conversation truth and
  submission path. The components own presentation state such as scroll position and disclosure only.
- Kept `AgentMdxStream` as Spark's safe Markdown and generative-UI rendering boundary; its Markdown
  blocks now use the Response/Streamdown implementation instead of the legacy block parser.
- Replaced upstream tool-state vocabulary with Spark states and expose only display-safe tool name,
  status, summary, and reference fields.
- Ported Chain of Thought's full-width collapsible header, status-aware step rail, staggered reveal,
  and streaming auto-open behavior into `ThinkingChainPart`. Search-result and image primitives stay
  out until the daemon exposes canonical display-safe data for them.
- Added a bounded live region, keyboard composer submission, IME-safe Enter handling, an accessible
  slash-command listbox, jump-to-latest, message copy, reduced-motion behavior, and Spark i18n labels
  supplied by the route shell. The composer keeps a Header/Body/command-surface/Footer split while
  leaving command semantics and form submission in their existing Spark owners.
- Approval actions are an optional snippet. Cockpit must provide it only when a canonical daemon
  interaction action exists; this directory does not create browser-local approval semantics.
- Ported Queue's collapsible count, bounded list, long-message treatment, and hover/focus action
  affordance into `SessionQueue`. The component receives daemon-projected items and an optional
  action snippet; it owns disclosure only and never creates, mutates, or submits a browser-local queue.

## Update procedure

Review the pinned upstream files manually, port useful behavior deliberately, update this record, and
run the Cockpit boundary, check, and test gates. Do not run an install-time registry overwrite.
