<script lang="ts">
  import { Dialog } from "bits-ui";
  import type { Snippet } from "svelte";

  // Reusable Bits UI dialog shell. It owns Root/Portal/Overlay/Content plus the
  // shared surface, centering, elevation, overflow, and mobile behavior so
  // individual dialogs only describe their own header/body/footer.
  //
  // This is the Spark-token analogue of shadcn-svelte's Dialog composition:
  // Bits UI stays the accessible focus-trap/escape/outside-click primitive, and
  // Cockpit owns the visual layer. Consumers still import `{ Dialog }` from
  // "bits-ui" for Title/Description/Close and, via the optional `trigger`
  // snippet, Trigger — all rendered inside this wrapper's Root context.

  let {
    open = $bindable(false),
    backdrop = "dim",
    layout = "block",
    overflow = "auto",
    mobile = "center",
    motion = "fade",
    width = "min(600px, calc(100vw - 32px))",
    maxHeight = "min(760px, calc(100dvh - 32px))",
    elevation = 100,
    describedBy,
    contentClass = "",
    onOpenChangeComplete,
    trigger,
    children,
  }: {
    /** Two-way open state. */
    open?: boolean;
    /** Overlay treatment: soft dim or blurred scrim. */
    backdrop?: "dim" | "blur";
    /** Content inner layout: `grid` for command/list bodies, `block` for forms. */
    layout?: "grid" | "block";
    /** Content overflow when the body exceeds max height. */
    overflow?: "hidden" | "auto";
    /** Narrow-screen behavior: bottom `sheet` or centered dialog. */
    mobile?: "sheet" | "center";
    /** Enter animation, respecting `prefers-reduced-motion`. */
    motion?: "fade" | "none";
    /** Desktop content width. */
    width?: string;
    /** Content max height. */
    maxHeight?: string;
    /** Base z-index; the content sits one above the overlay. */
    elevation?: number;
    /** id wired to `aria-describedby` (usually the Dialog.Description id). */
    describedBy?: string;
    /** Extra class merged onto the content element for per-dialog styling. */
    contentClass?: string;
    onOpenChangeComplete?: (open: boolean) => void;
    /** Optional trigger snippet; place a `<Dialog.Trigger>` inside it. */
    trigger?: Snippet;
    /** Dialog body: header, content, footer. */
    children: Snippet;
  } = $props();
</script>

<Dialog.Root bind:open {onOpenChangeComplete}>
  {@render trigger?.()}
  <Dialog.Portal>
    <Dialog.Overlay
      class="ui-dialog-overlay"
      data-backdrop={backdrop}
      data-motion={motion}
      style={`--ui-dialog-z:${elevation};`}
    />
    <Dialog.Content
      class={`ui-dialog-content ${contentClass}`.trim()}
      data-layout={layout}
      data-overflow={overflow}
      data-mobile={mobile}
      data-motion={motion}
      aria-describedby={describedBy}
      style={`--ui-dialog-z:${elevation + 1};--ui-dialog-width:${width};--ui-dialog-max-height:${maxHeight};`}
    >
      {@render children()}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.ui-dialog-overlay) {
    inset: 0;
    position: fixed;
    z-index: var(--ui-dialog-z, 100);
  }

  :global(.ui-dialog-overlay[data-backdrop="dim"]) {
    background: color-mix(in srgb, var(--color-ink) 32%, transparent);
  }

  :global(.ui-dialog-overlay[data-backdrop="blur"]) {
    backdrop-filter: blur(3px);
    background: color-mix(in srgb, var(--color-ink) 38%, transparent);
  }

  :global(.ui-dialog-content) {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-lg);
    box-shadow: var(--shadow-popover);
    left: 50%;
    max-height: var(--ui-dialog-max-height, min(760px, calc(100dvh - 32px)));
    max-width: calc(100vw - 32px);
    position: fixed;
    top: 50%;
    transform: translate(-50%, -50%);
    width: var(--ui-dialog-width, min(600px, calc(100vw - 32px)));
    z-index: var(--ui-dialog-z, 101);
  }

  :global(.ui-dialog-content[data-layout="grid"]) {
    display: grid;
  }

  :global(.ui-dialog-content[data-overflow="hidden"]) {
    overflow: hidden;
  }

  :global(.ui-dialog-content[data-overflow="auto"]) {
    overflow: auto;
  }

  :global(.ui-dialog-content:focus-visible) {
    outline: none;
  }

  @media (max-width: 640px) {
    :global(.ui-dialog-content[data-mobile="center"]) {
      max-height: min(
        var(--ui-dialog-max-height, calc(100dvh - 20px)),
        calc(100dvh - 20px)
      );
      max-width: calc(100vw - 20px);
      width: calc(100vw - 20px);
    }

    :global(.ui-dialog-content[data-mobile="sheet"]) {
      border-radius: var(--rounded-lg) var(--rounded-lg) 0 0;
      bottom: 0;
      left: 0;
      max-height: calc(100dvh - 16px);
      max-width: none;
      top: auto;
      transform: none;
      width: 100%;
    }
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(.ui-dialog-overlay[data-motion="fade"]),
    :global(.ui-dialog-content[data-motion="fade"]) {
      animation: ui-dialog-in 120ms ease-out;
    }

    @keyframes ui-dialog-in {
      from {
        opacity: 0;
      }
      to {
        opacity: 1;
      }
    }
  }
</style>
