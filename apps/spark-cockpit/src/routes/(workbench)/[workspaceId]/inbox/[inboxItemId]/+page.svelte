<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import { canActOnInboxApproval, canQuickDecideInboxApproval } from "$lib/inbox-approval-display";
  import { formatRelativeTime, statusLabel as getStatusLabel } from "$lib/i18n";

  let { data, form } = $props();
  let t = $derived(data.messages.inboxDetail);
  let common = $derived(data.messages.common);
  let latestResponse = $derived(data.latestResponses[0]);
  let canAct = $derived(canActOnInboxApproval(data.item));
  let canQuickDecide = $derived(canQuickDecideInboxApproval(data.item));

  function formatRelative(value: string | null) {
    return formatRelativeTime(value, data.locale, common);
  }

  function statusLabel(status: string) {
    return getStatusLabel(status, common);
  }

  function formatJson(value: unknown) {
    return JSON.stringify(value, null, 2);
  }
</script>

<svelte:head>
  <title>{data.item.title} · {t.headTitleSuffix} · Spark</title>
</svelte:head>

<section class="inbox-detail-page">
  <header class="hero">
    <div>
      <p class="eyebrow">{data.item.requestKind} · {data.item.runtimeName}</p>
      <h1>{data.item.title}</h1>
      <p class="lede">{data.item.prompt}</p>
    </div>
    <span class="status-pill {data.item.status}">{statusLabel(data.item.status)}</span>
  </header>

  <section class="meta-grid" aria-label={t.meta.aria}>
    <article>
      <span>{t.meta.project}</span>
      <strong>{data.item.projectName ?? common.fallback.workspaceScope}</strong>
    </article>
    <article>
      <span>{t.meta.runnerWorkspace}</span>
      <strong>{data.item.runtimeWorkspaceName ?? data.item.runtimeWorkspaceBindingId}</strong>
    </article>
    <article>
      <span>{t.meta.runnerRequest}</span>
      <strong>{data.item.runtimeRequestId}</strong>
    </article>
    <article>
      <span>{t.meta.created}</span>
      <strong>{formatRelative(data.item.createdAt)}</strong>
    </article>
  </section>

  <section class="grid">
    <section class="panel" aria-labelledby="response-title">
      <div class="panel-header">
        <div>
          <p class="panel-kicker">{t.response.kicker}</p>
          <h2 id="response-title">{t.response.title}</h2>
        </div>
      </div>

      {#if form?.message}
        <div class="form-error" role="alert">{form.message}</div>
      {/if}

      {#if canAct && data.item.approval.actionable}
        <section class="approval-card" aria-label="Approval center">
          <p class="panel-kicker">Approval center</p>
          <h3>{data.item.approval.title}</h3>
          <p>{data.item.approval.summary}</p>
          {#if data.item.approval.riskSummary.length > 0}
            <ul>
              {#each data.item.approval.riskSummary as risk}
                <li>{risk}</li>
              {/each}
            </ul>
          {/if}
          {#if canQuickDecide}
            <form method="POST" action="?/decide" class="approval-form">
              <label class="question-block">
                <span>{t.response.operatorNote}</span>
                <textarea name="operatorNote" rows="3" placeholder={t.response.operatorNotePlaceholder}></textarea>
              </label>
              <div class="form-actions">
                <button class="primary-action" type="submit" name="decision" value="approve">{data.item.approval.approveLabel}</button>
                <button class="danger-action" type="submit" name="decision" value="reject">{data.item.approval.rejectLabel}</button>
              </div>
            </form>
          {:else}
            <p class="approval-hint">Answer the required questions below, or cancel the request to reject it.</p>
          {/if}
        </section>
      {/if}

      {#if data.item.status === "pending" && data.item.requestStatus === "pending"}
        <form method="POST" action="?/respond">
          {#if data.item.questions.length === 0}
            <label class="question-block">
              <span>{t.response.answer}</span>
              <textarea name="answer:message" rows="6" placeholder={t.response.answerPlaceholder} required></textarea>
            </label>
          {:else}
            {#each data.item.questions as question}
              <fieldset class="question-block">
                <legend>{question.prompt}{question.required ? t.response.requiredMark : ""}</legend>

                {#if question.type === "single" && question.options?.length}
                  <div class="option-list">
                    {#each question.options as option}
                      <label class="option-row">
                        <input name={`answer:${question.id}`} type="radio" value={option.id} required={question.required} />
                        <span>
                          <strong>{option.label}</strong>
                          {#if option.description}<small>{option.description}</small>{/if}
                        </span>
                      </label>
                    {/each}
                  </div>
                {:else if question.type === "multi" && question.options?.length}
                  <div class="option-list">
                    {#each question.options as option}
                      <label class="option-row">
                        <input name={`answer:${question.id}`} type="checkbox" value={option.id} />
                        <span>
                          <strong>{option.label}</strong>
                          {#if option.description}<small>{option.description}</small>{/if}
                        </span>
                      </label>
                    {/each}
                  </div>
                {:else if question.type === "preview"}
                  <p class="preview-copy">{t.response.previewOnly}</p>
                {:else}
                  <textarea name={`answer:${question.id}`} rows="5" required={question.required}></textarea>
                {/if}
              </fieldset>
            {/each}
          {/if}

          <label class="question-block">
            <span>{t.response.operatorNote}</span>
            <textarea name="operatorNote" rows="3" placeholder={t.response.operatorNotePlaceholder}></textarea>
          </label>

          <div class="form-actions">
            <button class="primary-action" type="submit" name="status" value="answered">{t.response.send}</button>
            <button class="secondary-action" type="submit" name="status" value="cancelled">{t.response.cancel}</button>
            <button class="secondary-action" type="submit" name="status" value="archived">{t.response.archive}</button>
          </div>
        </form>
      {:else if latestResponse}
        <div class="answered-state">
          <div class="empty-icon"><Icon name="check" size={26} /></div>
          <div>
            <h3>{t.response.recordedTitle}</h3>
            <p>{t.response.statusPrefix} {statusLabel(latestResponse.status)}{latestResponse.ackedAt ? ` · ${t.response.runnerAcked}` : ` · ${t.response.waitingAck}`}</p>
          </div>
        </div>
        <pre>{formatJson(latestResponse.answer)}</pre>
      {:else}
        <div class="answered-state">
          <div class="empty-icon"><Icon name="archive" size={26} /></div>
          <div>
            <h3>{t.response.closedTitle}</h3>
            <p>{t.response.closedBody}</p>
          </div>
        </div>
      {/if}
    </section>

    <aside class="panel" aria-labelledby="context-title">
      <div class="panel-header compact">
        <div>
          <p class="panel-kicker">{t.audit.kicker}</p>
          <h2 id="context-title">{t.audit.title}</h2>
        </div>
      </div>

      <div class="audit-list">
        <article>
          <span>{t.audit.requestStatus}</span>
          <strong>{statusLabel(data.item.requestStatus)}</strong>
        </article>
        <article>
          <span>{t.audit.inboxStatus}</span>
          <strong>{statusLabel(data.item.status)}</strong>
        </article>
        {#if latestResponse}
          <article>
            <span>{t.audit.responseStatus}</span>
            <strong>{statusLabel(latestResponse.status)}</strong>
          </article>
          <article>
            <span>{t.audit.deliveryAttempts}</span>
            <strong>{latestResponse.deliveryAttemptCount}</strong>
          </article>
          <article>
            <span>{t.audit.lastDelivery}</span>
            <strong>{formatRelative(latestResponse.lastDeliveryAt)}</strong>
          </article>
        {/if}
      </div>

      <details>
        <summary>{t.audit.rawContext}</summary>
        <pre>{formatJson(data.item.context)}</pre>
      </details>
    </aside>
  </section>
</section>

<style>
  .inbox-detail-page {
    display: grid;
    gap: 24px;
  }

  .hero {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  .eyebrow,
  .panel-kicker {
    color: var(--color-primary);
    font-size: 12px;
    font-weight: 750;
    letter-spacing: 0.08em;
    margin: 0 0 8px;
    text-transform: uppercase;
  }

  h1,
  h2,
  h3,
  p {
    margin: 0;
  }

  h1 {
    font-size: 34px;
    letter-spacing: -0.03em;
  }

  .lede,
  .answered-state p,
  .preview-copy,
  .option-row small {
    color: var(--color-ink-subtle);
    line-height: 1.55;
  }

  .lede {
    margin-top: 10px;
    max-width: 760px;
  }

  .meta-grid,
  .grid {
    display: grid;
    gap: 18px;
  }

  .meta-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .meta-grid article,
  .panel {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 16px;
    box-shadow: var(--shadow-card-raised);
  }

  .meta-grid article {
    display: grid;
    gap: 8px;
    min-width: 0;
    padding: 18px;
  }

  .meta-grid span,
  .audit-list span {
    color: var(--color-ink-subtle);
    font-size: 12px;
    font-weight: 800;
    text-transform: uppercase;
  }

  .meta-grid strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .grid {
    align-items: start;
    grid-template-columns: minmax(0, 1fr) 360px;
  }

  .panel-header {
    align-items: center;
    border-bottom: 1px solid var(--color-border);
    display: flex;
    justify-content: space-between;
    padding: 24px 28px;
  }

  .panel-header.compact {
    padding: 22px 24px;
  }

  .status-pill {
    background: var(--color-surface-soft);
    border-radius: 999px;
    color: var(--color-ink-subtle);
    font-size: 12px;
    font-weight: 800;
    padding: 6px 10px;
    text-transform: capitalize;
  }

  .status-pill.pending {
    background: var(--color-warning-soft);
    color: var(--color-warning);
  }

  .status-pill.resolved {
    background: var(--color-success-soft);
    color: var(--color-success);
  }

  form,
  .audit-list,
  details {
    display: grid;
    gap: 16px;
    padding: 22px 24px 24px;
  }

  .approval-card {
    background: var(--color-primary-weak);
    border: 1px solid var(--color-primary-soft);
    border-radius: 14px;
    display: grid;
    gap: 12px;
    margin: 22px 24px 0;
    padding: 18px;
  }

  .approval-card ul {
    color: var(--color-ink-subtle);
    margin: 0;
    padding-left: 20px;
  }

  .approval-form {
    padding: 0;
  }

  .approval-hint {
    color: var(--color-ink-subtle);
    font-weight: 700;
  }

  .question-block {
    border: 0;
    display: grid;
    gap: 10px;
    margin: 0;
    min-width: 0;
    padding: 0;
  }

  .question-block > span,
  legend {
    color: var(--color-ink);
    font-size: 14px;
    font-weight: 800;
    padding: 0;
  }

  textarea {
    background: var(--color-canvas);
    border: 1px solid var(--color-border-strong);
    border-radius: 12px;
    color: var(--color-ink);
    font: inherit;
    padding: 12px;
    resize: vertical;
  }

  .option-list {
    display: grid;
    gap: 8px;
  }

  .option-row {
    align-items: flex-start;
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    display: flex;
    gap: 10px;
    padding: 12px;
  }

  .option-row span {
    display: grid;
    gap: 4px;
  }

  .form-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .primary-action,
  .secondary-action,
  .danger-action {
    align-items: center;
    border-radius: 12px;
    display: inline-flex;
    font-weight: 800;
    height: 44px;
    justify-content: center;
    padding: 0 16px;
  }

  .primary-action {
    background: var(--color-primary);
    border: 0;
    color: white;
    cursor: pointer;
  }

  .secondary-action {
    background: white;
    border: 1px solid var(--color-border);
    color: var(--color-ink-muted);
    cursor: pointer;
  }

  .danger-action {
    background: var(--color-danger-soft);
    border: 0;
    color: var(--color-danger-strong);
    cursor: pointer;
  }

  .form-error {
    background: var(--color-danger-weak);
    border-bottom: 1px solid var(--color-danger-soft);
    color: var(--color-danger-strong);
    font-weight: 700;
    padding: 14px 24px;
  }

  .answered-state {
    align-items: center;
    display: flex;
    gap: 14px;
    padding: 24px;
  }

  .empty-icon {
    background: var(--color-primary-weak);
    border-radius: 999px;
    color: var(--color-primary);
    display: grid;
    height: 52px;
    place-items: center;
    width: 52px;
  }

  .audit-list article {
    display: grid;
    gap: 6px;
  }

  details {
    border-top: 1px solid var(--color-border);
  }

  summary {
    color: var(--color-ink-muted);
    cursor: pointer;
    font-weight: 800;
  }

  pre {
    background: var(--color-ink);
    border-radius: 12px;
    color: var(--color-border);
    font-size: 12px;
    overflow: auto;
    padding: 14px;
    white-space: pre-wrap;
  }

  @media (max-width: 1100px) {
    .meta-grid,
    .grid {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 640px) {
    .hero,
    .panel-header {
      align-items: flex-start;
      flex-direction: column;
      gap: 14px;
    }

    .approval-card {
      margin: 16px 16px 0;
      padding: 16px;
    }

    form,
    .audit-list,
    details {
      padding: 18px 16px 20px;
    }

    .form-actions {
      display: grid;
      grid-template-columns: 1fr;
    }

    .primary-action,
    .secondary-action,
    .danger-action {
      width: 100%;
    }
  }
</style>
