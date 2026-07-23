<script lang="ts">
  import SessionInspector from "$lib/SessionInspector.svelte";
  import Icon from "$lib/Icon.svelte";
  import { visibleSessionStatus } from "$lib/conversation-status";
  import type { SessionInspectorLabels, SessionWorkbenchView } from "$lib/session-workbench";
  import type { SparkSideThreadSnapshot } from "@zendev-lab/spark-protocol";
  import type { SessionRecord, SessionsMessages } from "./types";

  type Props = {
    selected: SessionRecord;
    compact?: boolean;
    messages: SessionsMessages;
    statusLabel: (status: string) => string;
    sessionScopeLabel: string;
    selectedWorkspaceHref: string | null;
    selectedIsChannelSession: boolean;
    selectedChannelBindings: Array<{ adapter?: string; externalKey?: string }>;
    selectedChannelsSettingsHref: string | null;
    workbenchView: SessionWorkbenchView | null;
    inspectorLabels: SessionInspectorLabels;
    instanceId: string;
  };

  let {
    selected,
    compact = false,
    messages,
    statusLabel,
    sessionScopeLabel,
    selectedWorkspaceHref,
    selectedIsChannelSession,
    selectedChannelBindings,
    selectedChannelsSettingsHref,
    workbenchView,
    inspectorLabels,
    instanceId,
  }: Props = $props();

  let displayedSessionStatus = $derived(visibleSessionStatus(selected.status));
  let sideThread = $state<SparkSideThreadSnapshot | null>(null);
  let sideThreadState = $state<"idle" | "loading" | "missing" | "error">("idle");
  let sideThreadActionState = $state<"idle" | "submitting" | "error">("idle");
  let sideThreadPrompt = $state("");
  let sideThreadMode = $state<"contextual" | "tangent">("contextual");
  let sideThreadProvider = $state("");
  let sideThreadModel = $state("");
  let sideThreadThinking = $state("");
  let sideThreadHandoffInstructions = $state("");
  const sideThreadIdempotencyKeys = new Map<string, string>();

  async function loadSideThread(event: Event): Promise<void> {
    const panel = event.currentTarget as HTMLDetailsElement;
    if (!panel.open || sideThreadState === "loading") return;
    const parentSessionId = selected.sessionId;
    sideThreadState = "loading";
    try {
      const response = await fetch(
        `/api/v1/sessions/${encodeURIComponent(parentSessionId)}/side-thread`,
        { headers: { accept: "application/json" } },
      );
      if (selected.sessionId !== parentSessionId) return;
      if (response.status === 404) {
        sideThread = null;
        sideThreadState = "missing";
        return;
      }
      if (!response.ok) throw new Error(`side thread request failed: ${response.status}`);
      sideThread = (await response.json()) as SparkSideThreadSnapshot;
      adoptSideThreadSnapshot(sideThread);
      sideThreadState = "idle";
    } catch {
      sideThreadState = "error";
    }
  }

  async function controlSideThread(
    action: "ensure" | "submit" | "reset" | "configure" | "handoff",
    extra: Record<string, unknown> = {},
  ): Promise<boolean> {
    const parentSessionId = selected.sessionId;
    sideThreadActionState = "submitting";
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
      if (selected.sessionId !== parentSessionId) return true;
      const snapshot = snapshotFromControlResult(await response.json());
      if (snapshot) adoptSideThreadSnapshot(snapshot);
      sideThreadActionState = "idle";
      // A command response is authoritative enough to update the panel. A
      // follow-up GET is only convergence; its failure must not turn an
      // accepted daemon mutation into an apparent UI failure.
      void loadSideThreadSnapshot(parentSessionId).catch(() => undefined);
      return true;
    } catch {
      sideThreadActionState = "error";
      return false;
    }
  }

  async function loadSideThreadSnapshot(parentSessionId: string): Promise<void> {
    const response = await fetch(
      `/api/v1/sessions/${encodeURIComponent(parentSessionId)}/side-thread`,
      { headers: { accept: "application/json" } },
    );
    if (response.status === 404) {
      sideThread = null;
      sideThreadState = "missing";
      return;
    }
    if (!response.ok) throw new Error(`side thread request failed: ${response.status}`);
    sideThread = (await response.json()) as SparkSideThreadSnapshot;
    adoptSideThreadSnapshot(sideThread);
    sideThreadState = "idle";
  }

  function adoptSideThreadSnapshot(snapshot: SparkSideThreadSnapshot): void {
    sideThread = snapshot;
    sideThreadMode = snapshot.mode;
    sideThreadProvider = snapshot.modelOverride?.providerName ?? "";
    sideThreadModel = snapshot.modelOverride?.modelId ?? "";
    sideThreadThinking = snapshot.thinkingOverride ?? "";
  }

  function snapshotFromControlResult(value: unknown): SparkSideThreadSnapshot | null {
    const candidate =
      value && typeof value === "object" && "snapshot" in value
        ? (value as { snapshot?: unknown }).snapshot
        : value;
    if (
      !candidate ||
      typeof candidate !== "object" ||
      !("parentSessionId" in candidate) ||
      typeof candidate.parentSessionId !== "string"
    ) {
      return null;
    }
    return candidate as SparkSideThreadSnapshot;
  }

  function idempotencyKey(fingerprint: string): string {
    const existing = sideThreadIdempotencyKeys.get(fingerprint);
    if (existing) return existing;
    const key = crypto.randomUUID();
    sideThreadIdempotencyKeys.set(fingerprint, key);
    return key;
  }

  function clearIdempotencyKey(fingerprint: string): void {
    sideThreadIdempotencyKeys.delete(fingerprint);
  }

  function submitSideThread(): void {
    if (!sideThread || !sideThreadPrompt.trim()) return;
    const fingerprint = `submit:${sideThread.parentSessionId}:${sideThread.generation}:${sideThreadPrompt.trim()}`;
    void controlSideThread("submit", {
      expectedGeneration: sideThread.generation,
      prompt: sideThreadPrompt,
      idempotencyKey: idempotencyKey(fingerprint),
    }).then((accepted) => {
      if (accepted) {
        clearIdempotencyKey(fingerprint);
        sideThreadPrompt = "";
      }
    });
  }

  function configureSideThread(): void {
    if (!sideThread) return;
    if (!sideThreadModelPairIsValid()) {
      sideThreadActionState = "error";
      return;
    }
    void controlSideThread("configure", {
      expectedGeneration: sideThread.generation,
      modelOverride:
        sideThreadProvider.trim() && sideThreadModel.trim()
          ? { providerName: sideThreadProvider.trim(), modelId: sideThreadModel.trim() }
          : null,
      thinkingOverride: sideThreadThinking || null,
    });
  }

  function sideThreadModelPairIsValid(): boolean {
    return Boolean(sideThreadProvider.trim()) === Boolean(sideThreadModel.trim());
  }

  function handoffSideThread(kind: "full" | "summary"): void {
    if (!sideThread?.headExchangeId) return;
    const instructions = sideThreadHandoffInstructions.trim();
    const fingerprint = `handoff:${sideThread.parentSessionId}:${sideThread.generation}:${sideThread.headExchangeId}:${kind}:${instructions}`;
    void controlSideThread("handoff", {
      expectedGeneration: sideThread.generation,
      expectedHeadExchangeId: sideThread.headExchangeId,
      kind,
      ...(instructions ? { instructions } : {}),
      idempotencyKey: idempotencyKey(fingerprint),
    }).then((accepted) => {
      if (accepted) {
        clearIdempotencyKey(fingerprint);
        sideThreadHandoffInstructions = "";
      }
    });
  }
</script>

<div
  class:compact-details={compact}
  class="details-content"
  data-session-inspector-surface
  tabindex="-1"
>
  <dl class="details-grid">
    {#if displayedSessionStatus}
      <div>
        <dt>{messages.statusLabel}</dt>
        <dd>
          <span class="status-pill {displayedSessionStatus}">{statusLabel(displayedSessionStatus)}</span>
        </dd>
      </div>
    {/if}
    <div>
      <dt>{messages.workspaceLabel}</dt>
      <dd>
        {#if selectedWorkspaceHref}
          <a href={selectedWorkspaceHref}>{sessionScopeLabel}</a>
        {:else}
          {sessionScopeLabel}
        {/if}
      </dd>
    </div>
    {#if selected.role}
      <div>
        <dt>{messages.roleLabel}</dt>
        <dd>{selected.role}</dd>
      </div>
    {/if}
    {#if selectedIsChannelSession}
      <div>
        <dt>{messages.channelSessionBadge}</dt>
        <dd>
          <span class="channel-badge">{messages.channelSessionKicker}</span>
        </dd>
      </div>
      {#if selectedChannelBindings.length > 0}
        <div>
          <dt>{messages.channelBindingLabel}</dt>
          <dd class="channel-bindings">
            {#each selectedChannelBindings as binding (binding.externalKey ?? binding.adapter)}
              <code>{binding.externalKey ?? binding.adapter}</code>
            {/each}
          </dd>
        </div>
      {/if}
      {#if selectedChannelsSettingsHref}
        <div class="channel-settings-row">
          <a class="channel-settings-link" href={selectedChannelsSettingsHref}>
            <Icon name="settings" size={14} />
            {messages.openChannelSettings}
          </a>
          <p class="muted">{messages.channelRoutingBody}</p>
        </div>
      {/if}
    {/if}
  </dl>

  {#if workbenchView}
    <SessionInspector view={workbenchView} labels={inspectorLabels} {instanceId} {statusLabel} />
  {/if}

  <details class="side-thread-panel" ontoggle={loadSideThread}>
    <summary>
      <span>{messages.sideThread.title}</span>
    </summary>
    <p class="side-thread-description">{messages.sideThread.description}</p>
    {#if sideThreadState === "loading"}
      <p class="muted">{messages.sideThread.loading}</p>
    {:else if sideThreadState === "missing"}
      <p class="muted">{messages.sideThread.missing}</p>
      <div class="side-thread-actions">
        <label>
          {messages.sideThread.modeLabel}
          <select bind:value={sideThreadMode} disabled={sideThreadActionState === "submitting"}>
            <option value="contextual">contextual</option>
            <option value="tangent">tangent</option>
          </select>
        </label>
        <button
          type="button"
          disabled={sideThreadActionState === "submitting"}
          onclick={() => void controlSideThread("ensure", { mode: sideThreadMode })}
        >{messages.sideThread.open}</button>
      </div>
    {:else if sideThreadState === "error"}
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
      {#if sideThread.hasMore}
        <p class="muted">{messages.sideThread.earlierNotLoaded}</p>
      {/if}
      {#if sideThread.projectionTruncated}
        <p class="muted">{messages.sideThread.projectionTruncated}</p>
      {/if}
      <div class="side-thread-actions">
        <label>
          {messages.sideThread.modeLabel}
          <select bind:value={sideThreadMode} disabled={sideThreadActionState === "submitting"}>
            <option value="contextual">contextual</option>
            <option value="tangent">tangent</option>
          </select>
        </label>
        <button
          type="button"
          disabled={sideThreadActionState === "submitting"}
          onclick={() => {
            if (!sideThread) return;
            void controlSideThread("reset", {
              expectedGeneration: sideThread.generation,
              mode: sideThreadMode,
            });
          }}
        >{messages.sideThread.reset}</button>
      </div>
      <label class="side-thread-composer">
        {messages.sideThread.promptLabel}
        <textarea bind:value={sideThreadPrompt} placeholder={messages.sideThread.promptPlaceholder}></textarea>
      </label>
      <button
        type="button"
        disabled={sideThreadActionState === "submitting" || !sideThreadPrompt.trim()}
        onclick={submitSideThread}
      >{messages.sideThread.send}</button>
      <div class="side-thread-configuration">
        <label>{messages.sideThread.providerLabel}<input bind:value={sideThreadProvider} /></label>
        <label>{messages.sideThread.modelIdLabel}<input bind:value={sideThreadModel} /></label>
        <label>
          {messages.sideThread.thinkingLabel}
          <select bind:value={sideThreadThinking}>
            <option value="">{messages.sideThread.inherited}</option>
            <option value="off">off</option><option value="minimal">minimal</option>
            <option value="low">low</option><option value="medium">medium</option>
            <option value="high">high</option><option value="xhigh">xhigh</option>
          </select>
        </label>
        <button type="button" disabled={sideThreadActionState === "submitting" || !sideThreadModelPairIsValid()} onclick={configureSideThread}>{messages.sideThread.configure}</button>
      </div>
      {#if sideThread.headExchangeId}
        <label class="side-thread-composer">
          {messages.sideThread.handoffInstructionsLabel}
          <textarea bind:value={sideThreadHandoffInstructions} placeholder={messages.sideThread.handoffInstructionsPlaceholder}></textarea>
        </label>
        <div class="side-thread-actions">
          <button type="button" disabled={sideThreadActionState === "submitting"} onclick={() => handoffSideThread("full")}>{messages.sideThread.handoffFull}</button>
          <button type="button" disabled={sideThreadActionState === "submitting"} onclick={() => handoffSideThread("summary")}>{messages.sideThread.handoffSummary}</button>
        </div>
      {/if}
      {#if sideThreadActionState === "error"}
        <p class="muted">{messages.sideThread.actionFailed}</p>
      {/if}
    {/if}
  </details>
</div>

<style>
  .details-content {
    display: grid;
    gap: 20px;
  }

  .details-grid {
    display: grid;
    gap: 14px;
    margin: 0;
  }

  .side-thread-panel {
    border-top: 1px solid var(--color-border, var(--color-surface-soft));
    display: grid;
    gap: 12px;
    padding-top: 16px;
  }

  .side-thread-panel summary {
    align-items: center;
    color: var(--color-ink);
    cursor: pointer;
    display: flex;
    font-size: 13px;
    font-weight: 700;
    gap: 8px;
    justify-content: space-between;
  }

  .side-thread-description {
    color: var(--color-ink-subtle);
    font-size: 12px;
    line-height: 1.5;
    margin: 0;
  }

  .side-thread-actions,
  .side-thread-configuration {
    align-items: end;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .side-thread-actions label,
  .side-thread-configuration label,
  .side-thread-composer {
    color: var(--color-ink-subtle);
    display: grid;
    font-size: 11px;
    font-weight: 650;
    gap: 4px;
  }

  .side-thread-actions button,
  .side-thread-configuration button,
  .side-thread-panel > button {
    background: var(--color-accent, var(--color-ink));
    border: 0;
    border-radius: 6px;
    color: var(--color-on-accent, white);
    cursor: pointer;
    font: inherit;
    padding: 7px 10px;
  }

  .side-thread-panel input,
  .side-thread-panel select,
  .side-thread-panel textarea {
    background: var(--color-surface, white);
    border: 1px solid var(--color-border, var(--color-surface-soft));
    border-radius: 6px;
    color: var(--color-ink);
    font: inherit;
    padding: 6px 8px;
  }

  .side-thread-composer textarea {
    min-height: 72px;
    resize: vertical;
  }

  .side-thread-grid {
    display: grid;
    gap: 10px;
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
    border-radius: var(--rounded-md, 8px);
    display: grid;
    gap: 8px;
    padding: 10px;
  }

  .side-thread-exchanges p {
    color: var(--color-ink-muted);
    font-size: 12px;
    line-height: 1.5;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .details-grid div {
    display: grid;
    gap: 5px;
  }

  .details-grid dt {
    color: var(--color-ink-subtle);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .details-grid dd {
    color: var(--color-ink-muted);
    font-size: 13px;
    margin: 0;
    min-width: 0;
  }

  .details-grid a {
    color: var(--color-primary);
    text-decoration: none;
  }

  .channel-badge {
    background: color-mix(in srgb, var(--color-primary) 12%, transparent);
    border-radius: 999px;
    color: var(--color-primary);
    flex-shrink: 0;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.02em;
    line-height: 1;
    padding: 5px 8px;
    text-transform: none;
    white-space: nowrap;
  }

  .channel-settings-link {
    align-items: center;
    background: var(--color-surface-soft);
    border: 1px solid transparent;
    border-radius: var(--rounded-md, 8px);
    color: var(--color-ink);
    display: inline-flex;
    font-size: 12px;
    font-weight: 650;
    gap: 5px;
    padding: 6px 10px;
    text-decoration: none;
    white-space: nowrap;
  }

  .channel-settings-link:hover {
    background: var(--color-primary-weak);
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  .channel-bindings {
    display: grid;
    gap: 4px;
  }

  .channel-bindings code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    word-break: break-all;
  }

  .channel-settings-row {
    display: grid;
    gap: 6px;
    grid-column: 1 / -1;
  }

  .muted {
    color: var(--color-ink-subtle);
    font-size: 12px;
    line-height: 1.5;
  }

  .status-pill {
    background: var(--color-surface-soft);
    border-radius: 999px;
    color: var(--color-ink-subtle);
    font-size: 10px;
    font-weight: 650;
    padding: 4px 7px;
    text-transform: capitalize;
    white-space: nowrap;
  }

  .status-pill.running,
  .status-pill.ready,
  .status-pill.queued,
  .status-pill.acked {
    background: var(--color-primary-weak);
    color: var(--color-primary);
  }

  .status-pill.completed,
  .status-pill.success,
  .status-pill.delivered {
    background: var(--color-success-weak, #ecfdf5);
    color: var(--color-success-strong, #047857);
  }

  .status-pill.failed,
  .status-pill.error,
  .status-pill.rejected {
    background: var(--color-danger-weak, #fef2f2);
    color: var(--color-danger-strong, #b91c1c);
  }

  .status-pill.archived,
  .status-pill.cancelled {
    background: var(--color-warning-soft);
    color: var(--color-warning-strong, var(--color-warning));
  }
</style>
