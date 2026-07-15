<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import type { AppMessages } from "$lib/i18n";
  import type { ProjectTaskBoardColumn } from "$lib/project-task-board";

  let {
    columns,
    workspaceUrl,
    messages,
  }: {
    columns: ProjectTaskBoardColumn[];
    workspaceUrl: string;
    messages: AppMessages["taskBoard"];
  } = $props();

  function columnLabel(column: ProjectTaskBoardColumn): string {
    return (
      messages.columns[column.id as keyof AppMessages["taskBoard"]["columns"]] ?? column.label
    );
  }
</script>

<div class="task-board" aria-label={messages.aria}>
  {#each columns as column}
    <section
      class="task-board-column"
      aria-label={messages.columnTasksAria.replace("{column}", columnLabel(column))}
    >
      <header>
        <span>{columnLabel(column)}</span>
        <strong>{column.cards.length}</strong>
      </header>
      {#if column.cards.length === 0}
        <p class="muted board-empty">{messages.empty}</p>
      {:else}
        {#each column.cards as card}
          {@const task = card.task}
          <article class="task-card" class:ready-frontier={task.readyFrontier}>
            <div>
              <h3>{task.title}</h3>
              <p class="task-runtime-line">{task.runtimeTaskId}</p>
            </div>
            {#if task.readyFrontier}
              <span class="frontier-badge">{messages.readyFrontier}</span>
            {/if}
            {#if card.evidenceArtifacts.length > 0}
              <div
                class="evidence-links"
                aria-label={messages.evidenceForAria.replace("{task}", task.title)}
              >
                <span class="meta-label">{messages.evidence}</span>
                {#each card.evidenceArtifacts as artifact}
                  <a href={`${workspaceUrl}/artifacts/${artifact.id}`}>{artifact.title}</a>
                {/each}
              </div>
            {/if}
            <form method="POST" action="?/assignTask" class="assign-form">
              <input type="hidden" name="runtimeTaskId" value={task.runtimeTaskId} />
              <button type="submit" disabled={!card.assignable}>
                <Icon name="play" size={14} stroke={2.3} />
                <span>{card.assignable ? messages.assign : messages.notAssignable}</span>
              </button>
            </form>
          </article>
        {/each}
      {/if}
    </section>
  {/each}
</div>

<style>
  .task-board {
    display: grid;
    gap: 14px;
    grid-template-columns: repeat(4, minmax(180px, 1fr));
    overflow-x: auto;
    padding: 18px 18px 0;
  }

  .task-board-column {
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    border-radius: 14px;
    display: grid;
    gap: 10px;
    min-width: 180px;
    padding: 12px;
  }

  .task-board-column > header {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  .task-board-column > header span,
  .frontier-badge {
    color: var(--color-ink-muted);
    font-size: 12px;
    font-weight: 850;
    text-transform: uppercase;
  }

  .task-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    display: grid;
    gap: 10px;
    padding: 12px;
  }

  .task-card.ready-frontier {
    border-color: var(--color-focus-ring);
    box-shadow: var(--shadow-focus);
  }

  .task-card h3 {
    font-size: 14px;
    line-height: 1.35;
    margin: 0;
  }

  .task-runtime-line,
  .muted {
    color: var(--color-ink-subtle);
    font-size: 12px;
    line-height: 1.45;
    margin: 0;
  }

  .frontier-badge {
    background: var(--color-warning-soft);
    border-radius: 999px;
    color: var(--color-warning);
    justify-self: start;
    padding: 5px 8px;
  }

  .evidence-links {
    display: grid;
    gap: 5px;
  }

  .evidence-links a {
    color: var(--color-primary);
    font-size: 12px;
    font-weight: 750;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta-label {
    color: var(--color-ink-subtle);
    font-size: 11px;
    font-weight: 850;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .assign-form button {
    align-items: center;
    background: var(--color-primary);
    border: 0;
    border-radius: 8px;
    color: var(--color-surface);
    display: inline-flex;
    font: inherit;
    font-weight: 800;
    gap: 6px;
    justify-content: center;
    min-height: 36px;
    padding: 8px 10px;
    width: 100%;
  }

  .assign-form button:disabled {
    background: var(--color-border);
    color: var(--color-ink-disabled);
    cursor: not-allowed;
  }

  .board-empty {
    font-size: 12px;
  }

  @media (max-width: 1100px) {
    .task-board {
      grid-template-columns: repeat(2, minmax(180px, 1fr));
    }
  }

  @media (max-width: 700px) {
    .task-board {
      grid-template-columns: 1fr;
      overflow-x: visible;
      padding: 16px;
    }
  }
</style>
