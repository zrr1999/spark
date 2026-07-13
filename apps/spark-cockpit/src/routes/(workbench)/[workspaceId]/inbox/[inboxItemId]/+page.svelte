<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import { formatRelativeTime, statusLabel as getStatusLabel } from "$lib/i18n";
  import { Button, Field, Panel, Textarea } from "$lib/ui";
  import { workspacePath } from "$lib/workspace-routes";

  let { data, form } = $props();
  let t = $derived(data.messages.inboxDetail);
  let common = $derived(data.messages.common);
  let latestResponse = $derived(data.latestResponses[0]);

  function formatRelative(value: string | null) {
    return formatRelativeTime(value, data.locale, common);
  }

  function statusLabel(status: string) {
    return data.messages.inbox.status[status as keyof typeof data.messages.inbox.status] ?? getStatusLabel(status, common);
  }

  function formatJson(value: unknown) {
    return JSON.stringify(value, null, 2);
  }
</script>

<svelte:head>
  <title>{data.item.title} · {t.headTitleSuffix} · Spark</title>
</svelte:head>

<section class="inbox-detail-page">
  <nav class="page-actions" aria-label={t.navigation.aria}>
    <a href={workspacePath({ slug: data.item.workspaceSlug }, "/inbox")}>
      <span class="back-icon"><Icon name="chevron" size={15} /></span>{t.navigation.back}
    </a>
    {#if data.item.sessionId}
      <a href={`/sessions/${encodeURIComponent(data.item.sessionId)}`}>
        <Icon name="spark" size={15} />{t.navigation.conversation}
      </a>
    {/if}
  </nav>
  <header class="hero">
    <div>
      <h1>{data.item.title}</h1>
      <p class="lede">{data.item.prompt}</p>
      <p class="created-at">{formatRelative(data.item.createdAt)}</p>
    </div>
    <span class="status-pill {data.item.status}">{statusLabel(data.item.status)}</span>
  </header>

  <section class="response-stack">
    <Panel
      class="response-panel"
      title={t.response.title}
      kicker={t.response.kicker}
      ariaLabelledby="response-title"
      padded={false}
    >

      {#if form?.message}
        <div class="form-error" role="alert">{form.message}</div>
      {/if}

      {#if data.item.status === "pending" && data.item.requestStatus === "pending"}
        <form method="POST" action="?/respond">
          {#if data.item.questions.length === 0}
            <Field id="answer-message" label={t.response.answer} required>
              <Textarea
                id="answer-message"
                name="answer:message"
                rows={6}
                placeholder={t.response.answerPlaceholder}
                required
              />
            </Field>
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
                  <Textarea
                    id={`answer-${question.id}`}
                    name={`answer:${question.id}`}
                    rows={5}
                    required={question.required}
                    aria-label={question.prompt}
                  />
                {/if}
              </fieldset>
            {/each}
          {/if}

          <details class="optional-note">
            <summary>{t.response.operatorNote}</summary>
            <Textarea
              id="operator-note"
              name="operatorNote"
              rows={3}
              placeholder={t.response.operatorNotePlaceholder}
              aria-label={t.response.operatorNote}
            />
          </details>

          <div class="form-actions">
            <Button type="submit" name="status" value="answered">{t.response.send}</Button>
            <Button variant="secondary" type="submit" name="status" value="cancelled">{t.response.cancel}</Button>
          </div>

          <details class="optional-note more-actions">
            <summary>{t.response.moreActions}</summary>
            <p>{t.response.archiveHint}</p>
            <Button variant="secondary" type="submit" name="status" value="archived">{t.response.archive}</Button>
          </details>
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
    </Panel>

    <details class="technical-details">
      <summary><span><strong>{t.audit.title}</strong><small>{t.audit.kicker}</small></span></summary>
      <div class="technical-body">
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

      <details class="raw-context">
        <summary>{t.audit.rawContext}</summary>
        <pre>{formatJson(data.item.context)}</pre>
      </details>
      </div>
    </details>
  </section>
</section>

<style>
  .inbox-detail-page {
    display: grid;
    gap: 24px;
  }

  .page-actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
  }

  .page-actions a {
    align-items: center;
    color: var(--color-ink-muted);
    display: inline-flex;
    font-size: 13px;
    font-weight: 750;
    gap: 5px;
    text-decoration: none;
  }

  .back-icon {
    display: inline-flex;
    transform: rotate(180deg);
  }

  .hero {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  .hero > div {
    min-width: 0;
  }

  h1,
  h3,
  p {
    margin: 0;
  }

  h1 {
    font-size: 34px;
    letter-spacing: -0.03em;
    overflow-wrap: anywhere;
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

  .created-at {
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
    margin-top: var(--spacing-xs);
  }

  .audit-list span {
    color: var(--color-ink-subtle);
    font-size: 12px;
    font-weight: 800;
    text-transform: uppercase;
  }

  .response-stack {
    display: grid;
    gap: var(--spacing-lg);
  }

  :global(.response-panel .ui-panel-body) { gap: 0; }

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
  .audit-list {
    display: grid;
    gap: 16px;
    padding: 22px 24px 24px;
  }

  .optional-note {
    border: 1px solid var(--color-border-soft);
    border-radius: var(--rounded-md);
    padding: var(--spacing-sm);
  }

  .optional-note summary {
    align-items: center;
    color: var(--color-ink-muted);
    cursor: pointer;
    display: flex;
    font-weight: var(--weight-button);
    min-height: 40px;
  }

  .optional-note[open] summary { margin-bottom: var(--spacing-sm); }

  .more-actions p {
    color: var(--color-ink-subtle);
    line-height: var(--leading-body);
    margin: 0 0 var(--spacing-sm);
  }

  .question-block {
    border: 0;
    display: grid;
    gap: 10px;
    margin: 0;
    min-width: 0;
    padding: 0;
  }

  legend {
    color: var(--color-ink);
    font-size: 14px;
    font-weight: 800;
    padding: 0;
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

  .raw-context summary {
    align-items: center;
    color: var(--color-ink-muted);
    cursor: pointer;
    display: flex;
    font-weight: 800;
    min-height: 40px;
  }

  .technical-details {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-lg);
    overflow: hidden;
  }

  .technical-details > summary {
    cursor: pointer;
    list-style: none;
    padding: var(--spacing-lg) var(--spacing-xl);
  }

  .technical-details > summary::-webkit-details-marker { display: none; }
  .technical-details > summary span { display: grid; gap: var(--spacing-xxs); }
  .technical-details > summary small { color: var(--color-ink-subtle); font-weight: 400; }
  .technical-details[open] > summary { border-bottom: 1px solid var(--color-border); }
  .technical-body { display: grid; gap: var(--spacing-md); padding: var(--spacing-xl); }
  .technical-body .audit-list { padding: 0; }
  .raw-context { border-top: 1px solid var(--color-border-soft); padding-top: var(--spacing-sm); }

  pre {
    background: var(--color-ink);
    border-radius: 12px;
    color: var(--color-border);
    font-size: 12px;
    overflow: auto;
    padding: 14px;
    white-space: pre-wrap;
  }

  @media (max-width: 640px) {
    .hero {
      align-items: flex-start;
      flex-direction: column;
      gap: 12px;
    }

    h1 {
      font-size: 28px;
    }

  }
</style>
