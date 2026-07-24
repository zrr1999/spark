<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import type { SparkSideThreadSnapshot } from "@zendev-lab/spark-protocol";
  import type { SessionsMessages } from "./types";

  let {
    sessionId,
    messages,
    statusLabel,
    onClose,
  }: {
    sessionId: string;
    messages: SessionsMessages;
    statusLabel: (status: string) => string;
    onClose: () => void;
  } = $props();

  let sideThread = $state<SparkSideThreadSnapshot | null>(null);
  let loadState = $state<"loading" | "missing" | "idle" | "error">("loading");
  let actionState = $state<"idle" | "submitting" | "error">("idle");
  let prompt = $state("");
  let mode = $state<"contextual" | "tangent">("contextual");
  let provider = $state("");
  let model = $state("");
  let thinking = $state("");
  let handoffInstructions = $state("");
  const idempotencyKeys = new Map<string, string>();

  $effect(() => {
    const parentSessionId = sessionId;
    loadState = "loading";
    sideThread = null;
    void loadSnapshot(parentSessionId);
  });

  async function loadSnapshot(parentSessionId: string): Promise<void> {
    try {
      const response = await fetch(
        `/api/v1/sessions/${encodeURIComponent(parentSessionId)}/side-thread`,
        { headers: { accept: "application/json" } },
      );
      if (sessionId !== parentSessionId) return;
      if (response.status === 404) {
        sideThread = null;
        loadState = "missing";
        return;
      }
      if (!response.ok) throw new Error(`side thread request failed: ${response.status}`);
      adoptSnapshot((await response.json()) as SparkSideThreadSnapshot);
      loadState = "idle";
    } catch {
      if (sessionId === parentSessionId) loadState = "error";
    }
  }

  async function control(
    action: "ensure" | "submit" | "reset" | "configure" | "handoff",
    extra: Record<string, unknown> = {},
  ): Promise<boolean> {
    const parentSessionId = sessionId;
    actionState = "submitting";
    try {
      const response = await fetch(
        `/api/v1/sessions/${encodeURIComponent(parentSessionId)}/side-thread`,
        {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ action, ...extra }),
        },
      );
      if (!response.ok) throw new Error(`side thread action failed: ${response.status}`);
      if (sessionId !== parentSessionId) return true;
      const snapshot = snapshotFromControlResult(await response.json());
      if (snapshot) adoptSnapshot(snapshot);
      actionState = "idle";
      void loadSnapshot(parentSessionId);
      return true;
    } catch {
      if (sessionId === parentSessionId) actionState = "error";
      return false;
    }
  }

  function adoptSnapshot(snapshot: SparkSideThreadSnapshot): void {
    sideThread = snapshot;
    mode = snapshot.mode;
    provider = snapshot.modelOverride?.providerName ?? "";
    model = snapshot.modelOverride?.modelId ?? "";
    thinking = snapshot.thinkingOverride ?? "";
  }

  function snapshotFromControlResult(value: unknown): SparkSideThreadSnapshot | null {
    const candidate =
      value && typeof value === "object" && "snapshot" in value
        ? (value as { snapshot?: unknown }).snapshot
        : value;
    return candidate &&
      typeof candidate === "object" &&
      "parentSessionId" in candidate &&
      typeof candidate.parentSessionId === "string"
      ? (candidate as SparkSideThreadSnapshot)
      : null;
  }

  function idempotencyKey(fingerprint: string): string {
    const existing = idempotencyKeys.get(fingerprint);
    if (existing) return existing;
    const key = crypto.randomUUID();
    idempotencyKeys.set(fingerprint, key);
    return key;
  }

  function submit(): void {
    if (!sideThread || !prompt.trim()) return;
    const fingerprint = `submit:${sideThread.parentSessionId}:${sideThread.generation}:${prompt.trim()}`;
    void control("submit", {
      expectedGeneration: sideThread.generation,
      prompt: prompt.trim(),
      idempotencyKey: idempotencyKey(fingerprint),
    }).then((accepted) => {
      if (!accepted) return;
      idempotencyKeys.delete(fingerprint);
      prompt = "";
    });
  }

  function configure(): void {
    if (!sideThread || !modelPairIsValid()) {
      actionState = "error";
      return;
    }
    void control("configure", {
      expectedGeneration: sideThread.generation,
      modelOverride:
        provider.trim() && model.trim()
          ? { providerName: provider.trim(), modelId: model.trim() }
          : null,
      thinkingOverride: thinking || null,
    });
  }

  function modelPairIsValid(): boolean {
    return Boolean(provider.trim()) === Boolean(model.trim());
  }

  function handoff(kind: "full" | "summary"): void {
    if (!sideThread?.headExchangeId) return;
    const instructions = handoffInstructions.trim();
    const fingerprint = `handoff:${sideThread.parentSessionId}:${sideThread.generation}:${sideThread.headExchangeId}:${kind}:${instructions}`;
    void control("handoff", {
      expectedGeneration: sideThread.generation,
      expectedHeadExchangeId: sideThread.headExchangeId,
      kind,
      ...(instructions ? { instructions } : {}),
      idempotencyKey: idempotencyKey(fingerprint),
    }).then((accepted) => {
      if (!accepted) return;
      idempotencyKeys.delete(fingerprint);
      handoffInstructions = "";
    });
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === "Escape") onClose();
  }}
/>

<div class="side-thread-layer">
  <button
    class="side-thread-backdrop"
    type="button"
    aria-label={messages.sideThread.close}
    onclick={onClose}
  ></button>
  <div
    class="side-thread-dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="side-thread-title"
  >
    <header>
      <div>
        <p>{messages.sideThread.description}</p>
        <h2 id="side-thread-title">{messages.sideThread.title}</h2>
      </div>
      <button
        class="close-button"
        type="button"
        aria-label={messages.sideThread.close}
        title={messages.sideThread.close}
        onclick={onClose}
      >
        <Icon name="close" size={17} stroke={2.2} />
      </button>
    </header>

    <div class="side-thread-content">
      {#if loadState === "loading"}
        <p class="muted">{messages.sideThread.loading}</p>
      {:else if loadState === "missing"}
        <div class="empty-state">
          <p>{messages.sideThread.missing}</p>
          <label>
            {messages.sideThread.modeLabel}
            <select bind:value={mode} disabled={actionState === "submitting"}>
              <option value="contextual">contextual</option>
              <option value="tangent">tangent</option>
            </select>
          </label>
          <button
            class="primary"
            type="button"
            disabled={actionState === "submitting"}
            onclick={() => void control("ensure", { mode })}
          >{messages.sideThread.open}</button>
        </div>
      {:else if loadState === "error"}
        <p class="muted">{messages.sideThread.unavailable}</p>
      {:else if sideThread}
        <dl class="side-thread-grid">
          <div><dt>{messages.sideThread.modeLabel}</dt><dd>{sideThread.mode}</dd></div>
          <div><dt>{messages.sideThread.generationLabel}</dt><dd>{sideThread.generation}</dd></div>
          <div><dt>{messages.sideThread.statusLabel}</dt><dd>{statusLabel(sideThread.status)}</dd></div>
          <div><dt>{messages.sideThread.modelLabel}</dt><dd>{sideThread.effectiveModel ? `${sideThread.effectiveModel.providerName}/${sideThread.effectiveModel.modelId}` : messages.sideThread.inherited}</dd></div>
          <div><dt>{messages.sideThread.thinkingLabel}</dt><dd>{sideThread.effectiveThinkingLevel ?? messages.sideThread.inherited}</dd></div>
          <div><dt>{messages.sideThread.pendingLabel}</dt><dd>{sideThread.pendingTurns.length}</dd></div>
        </dl>

        {#if sideThread.exchanges.length > 0}
          <ol class="side-thread-exchanges">
            {#each sideThread.exchanges as exchange (exchange.id)}
              <li>
                <p><strong>{messages.sideThread.questionLabel}</strong> {exchange.user}</p>
                <p><strong>{messages.sideThread.findingLabel}</strong> {exchange.assistant}</p>
              </li>
            {/each}
          </ol>
        {:else}
          <p class="muted">{messages.sideThread.noExchanges}</p>
        {/if}
        {#if sideThread.hasMore}<p class="muted">{messages.sideThread.earlierNotLoaded}</p>{/if}
        {#if sideThread.projectionTruncated}<p class="muted">{messages.sideThread.projectionTruncated}</p>{/if}

        <div class="control-row">
          <label>
            {messages.sideThread.modeLabel}
            <select bind:value={mode} disabled={actionState === "submitting"}>
              <option value="contextual">contextual</option>
              <option value="tangent">tangent</option>
            </select>
          </label>
          <button
            type="button"
            disabled={actionState === "submitting"}
            onclick={() => void control("reset", {
              expectedGeneration: sideThread?.generation,
              mode,
            })}
          >{messages.sideThread.reset}</button>
        </div>

        <label class="field">
          {messages.sideThread.promptLabel}
          <textarea bind:value={prompt} placeholder={messages.sideThread.promptPlaceholder}></textarea>
        </label>
        <button
          class="primary"
          type="button"
          disabled={actionState === "submitting" || !prompt.trim()}
          onclick={submit}
        >{messages.sideThread.send}</button>

        <div class="configuration">
          <label>{messages.sideThread.providerLabel}<input bind:value={provider} /></label>
          <label>{messages.sideThread.modelIdLabel}<input bind:value={model} /></label>
          <label>
            {messages.sideThread.thinkingLabel}
            <select bind:value={thinking}>
              <option value="">{messages.sideThread.inherited}</option>
              <option value="off">off</option><option value="minimal">minimal</option>
              <option value="low">low</option><option value="medium">medium</option>
              <option value="high">high</option><option value="xhigh">xhigh</option>
            </select>
          </label>
          <button
            type="button"
            disabled={actionState === "submitting" || !modelPairIsValid()}
            onclick={configure}
          >{messages.sideThread.configure}</button>
        </div>

        {#if sideThread.headExchangeId}
          <label class="field">
            {messages.sideThread.handoffInstructionsLabel}
            <textarea bind:value={handoffInstructions} placeholder={messages.sideThread.handoffInstructionsPlaceholder}></textarea>
          </label>
          <div class="control-row">
            <button type="button" disabled={actionState === "submitting"} onclick={() => handoff("full")}>{messages.sideThread.handoffFull}</button>
            <button type="button" disabled={actionState === "submitting"} onclick={() => handoff("summary")}>{messages.sideThread.handoffSummary}</button>
          </div>
        {/if}
        {#if actionState === "error"}<p class="muted">{messages.sideThread.actionFailed}</p>{/if}
      {/if}
    </div>
  </div>
</div>

<style>
  .side-thread-layer {
    inset: 0;
    position: fixed;
    z-index: 80;
  }

  .side-thread-backdrop {
    background: color-mix(in srgb, var(--color-ink) 28%, transparent);
    border: 0;
    inset: 0;
    padding: 0;
    position: absolute;
    width: 100%;
  }

  .side-thread-dialog {
    background: var(--color-surface, white);
    border: 1px solid var(--color-border, var(--color-surface-soft));
    border-radius: 16px 0 0 16px;
    bottom: 0;
    box-shadow: -16px 0 48px color-mix(in srgb, var(--color-ink) 14%, transparent);
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    max-width: min(520px, calc(100vw - 24px));
    position: absolute;
    right: 0;
    top: 0;
    width: 100%;
  }

  header {
    align-items: start;
    border-bottom: 1px solid var(--color-border, var(--color-surface-soft));
    display: flex;
    gap: 16px;
    justify-content: space-between;
    padding: 20px 22px;
  }

  header h2 {
    color: var(--color-ink);
    font-size: 18px;
    margin: 4px 0 0;
  }

  header p {
    color: var(--color-ink-subtle);
    font-size: 12px;
    line-height: 1.45;
    margin: 0;
  }

  .close-button {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: 8px;
    color: var(--color-ink-muted);
    cursor: pointer;
    display: inline-flex;
    height: 32px;
    justify-content: center;
    width: 32px;
  }

  .side-thread-content {
    align-content: start;
    display: grid;
    gap: 16px;
    overflow: auto;
    padding: 20px 22px 28px;
  }

  .empty-state {
    align-items: start;
    display: grid;
    gap: 14px;
  }

  .empty-state p,
  .muted {
    color: var(--color-ink-subtle);
    font-size: 12px;
    line-height: 1.5;
    margin: 0;
  }

  .control-row,
  .configuration {
    align-items: end;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  label,
  .field {
    color: var(--color-ink-subtle);
    display: grid;
    font-size: 11px;
    font-weight: 650;
    gap: 5px;
  }

  button:not(.side-thread-backdrop, .close-button) {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border, transparent);
    border-radius: 7px;
    color: var(--color-ink);
    cursor: pointer;
    font: inherit;
    padding: 7px 10px;
  }

  button.primary {
    background: var(--color-accent, var(--color-primary));
    border-color: transparent;
    color: var(--color-on-accent, white);
    justify-self: start;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  input,
  select,
  textarea {
    background: var(--color-surface, white);
    border: 1px solid var(--color-border, var(--color-surface-soft));
    border-radius: 7px;
    color: var(--color-ink);
    font: inherit;
    padding: 7px 9px;
  }

  textarea {
    min-height: 78px;
    resize: vertical;
  }

  .side-thread-grid {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    margin: 0;
  }

  .side-thread-grid div {
    display: grid;
    gap: 3px;
    min-width: 0;
  }

  .side-thread-grid dt {
    color: var(--color-ink-subtle);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .side-thread-grid dd {
    color: var(--color-ink-muted);
    font-size: 12px;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .side-thread-exchanges {
    display: grid;
    gap: 10px;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .side-thread-exchanges li {
    background: var(--color-surface-soft);
    border-radius: 10px;
    display: grid;
    gap: 8px;
    padding: 12px;
  }

  .side-thread-exchanges p {
    color: var(--color-ink-muted);
    font-size: 12px;
    line-height: 1.5;
    margin: 0;
    overflow-wrap: anywhere;
  }

  @media (max-width: 640px) {
    .side-thread-dialog {
      border-radius: 14px 14px 0 0;
      max-width: none;
      top: 48px;
    }
  }
</style>
