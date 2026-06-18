---
version: alpha
name: Navia Operational Interface
description: "A light, precise, evidence-first interface system for Navia's agentic project dashboard. Inspired by the supplied screenshots and the awesome-design-md format: this file describes only visual/interface design — mood, colors, typography, layout, components, states, and responsive behavior. Product architecture, ownership, and data-model decisions live in separate architecture documents."

colors:
   primary: "#2563EB"
   primary-hover: "#1D4ED8"
   primary-soft: "#DBEAFE"
   primary-weak: "#EFF6FF"
   on-primary: "#FFFFFF"

   canvas: "#F8FAFC"
   surface: "#FFFFFF"
   surface-soft: "#F1F5F9"
   surface-muted: "#EEF2F7"
   surface-raised: "#FFFFFF"

   border: "#E2E8F0"
   border-soft: "#EDF2F7"
   border-strong: "#CBD5E1"
   focus-ring: "#93C5FD"

   ink: "#0F172A"
   ink-muted: "#475569"
   ink-subtle: "#64748B"
   ink-disabled: "#94A3B8"
   on-dark: "#E2E8F0"

   success: "#16A34A"
   success-strong: "#15803D"
   success-soft: "#DCFCE7"
   success-weak: "#F0FDF4"

   warning: "#F97316"
   warning-strong: "#9A3412"
   warning-soft: "#FFEDD5"
   warning-weak: "#FFF7ED"

   danger: "#EF4444"
   danger-strong: "#B91C1C"
   danger-soft: "#FEE2E2"
   danger-weak: "#FEF2F2"

   info: "#1D4ED8"
   info-soft: "#DBEAFE"
   info-strong: "#1E40AF"

   purple: "#7C3AED"
   purple-soft: "#EDE9FE"

   code-surface: "#0F172A"
   code-surface-soft: "#1E293B"
   code-ink: "#E2E8F0"
   code-muted: "#94A3B8"

typography:
   display:
      fontFamily: "Inter, Geist Sans, ui-sans-serif, system-ui, sans-serif"
      fontSize: 32px
      fontWeight: 600
      lineHeight: 1.2
      letterSpacing: "-0.02em"
   page-title:
      fontFamily: "Inter, Geist Sans, ui-sans-serif, system-ui, sans-serif"
      fontSize: 24px
      fontWeight: 600
      lineHeight: 1.25
      letterSpacing: "-0.01em"
   section-title:
      fontFamily: "Inter, Geist Sans, ui-sans-serif, system-ui, sans-serif"
      fontSize: 18px
      fontWeight: 600
      lineHeight: 1.35
      letterSpacing: "-0.005em"
   card-title:
      fontFamily: "Inter, Geist Sans, ui-sans-serif, system-ui, sans-serif"
      fontSize: 15px
      fontWeight: 600
      lineHeight: 1.4
   body:
      fontFamily: "Inter, Geist Sans, ui-sans-serif, system-ui, sans-serif"
      fontSize: 14px
      fontWeight: 400
      lineHeight: 1.55
   body-medium:
      fontFamily: "Inter, Geist Sans, ui-sans-serif, system-ui, sans-serif"
      fontSize: 14px
      fontWeight: 500
      lineHeight: 1.55
   caption:
      fontFamily: "Inter, Geist Sans, ui-sans-serif, system-ui, sans-serif"
      fontSize: 12px
      fontWeight: 400
      lineHeight: 1.45
   caption-medium:
      fontFamily: "Inter, Geist Sans, ui-sans-serif, system-ui, sans-serif"
      fontSize: 12px
      fontWeight: 500
      lineHeight: 1.45
   mono:
      fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
      fontSize: 12px
      fontWeight: 400
      lineHeight: 1.5
   button:
      fontFamily: "Inter, Geist Sans, ui-sans-serif, system-ui, sans-serif"
      fontSize: 14px
      fontWeight: 500
      lineHeight: 1.2

rounded:
   xs: 4px
   sm: 6px
   md: 8px
   lg: 12px
   xl: 16px
   full: 9999px

spacing:
   xxs: 4px
   xs: 8px
   sm: 12px
   md: 16px
   lg: 20px
   xl: 24px
   xxl: 32px
   section: 48px

shadows:
   card: "0 1px 2px rgba(15, 23, 42, 0.04)"
   card-raised: "0 18px 48px rgba(15, 23, 42, 0.04)"
   popover: "0 16px 40px rgba(15, 23, 42, 0.12)"
   focus: "0 0 0 3px rgba(147, 197, 253, 0.45)"

components:
   app-shell:
      backgroundColor: "{colors.canvas}"
      textColor: "{colors.ink}"
      typography: "{typography.body}"

   sidebar:
      backgroundColor: "{colors.surface}"
      textColor: "{colors.ink-muted}"
      border: "1px solid {colors.border}"
      width: 240px

   sidebar-item:
      backgroundColor: "transparent"
      textColor: "{colors.ink-muted}"
      typography: "{typography.body-medium}"
      rounded: "{rounded.md}"
      padding: "10px 12px"

   sidebar-item-hover:
      backgroundColor: "{colors.surface-soft}"
      textColor: "{colors.ink}"

   sidebar-item-active:
      backgroundColor: "{colors.primary-weak}"
      textColor: "{colors.primary}"
      typography: "{typography.body-medium}"
      rounded: "{rounded.md}"

   top-bar:
      backgroundColor: "{colors.surface}"
      textColor: "{colors.ink}"
      border: "1px solid {colors.border}"
      height: 64px

   stat-card:
      backgroundColor: "{colors.surface}"
      textColor: "{colors.ink}"
      typography: "{typography.card-title}"
      rounded: "{rounded.lg}"
      padding: "{spacing.xl}"
      border: "1px solid {colors.border}"
      shadow: "0 1px 2px rgba(15, 23, 42, 0.04)"

   panel-card:
      backgroundColor: "{colors.surface}"
      textColor: "{colors.ink}"
      typography: "{typography.body}"
      rounded: "{rounded.lg}"
      padding: "{spacing.xl}"
      border: "1px solid {colors.border}"
      shadow: "0 1px 2px rgba(15, 23, 42, 0.04)"

   compact-card:
      backgroundColor: "{colors.surface}"
      textColor: "{colors.ink}"
      typography: "{typography.body}"
      rounded: "{rounded.md}"
      padding: "{spacing.md}"
      border: "1px solid {colors.border}"

   cluster-card:
      backgroundColor: "{colors.surface}"
      textColor: "{colors.ink}"
      rounded: "{rounded.lg}"
      padding: "{spacing.md}"
      border: "1px solid {colors.border}"

   task-row:
      backgroundColor: "{colors.surface}"
      textColor: "{colors.ink}"
      typography: "{typography.body}"
      rounded: "{rounded.md}"
      padding: "10px 12px"
      border: "1px solid {colors.border-soft}"

   task-row-hover:
      backgroundColor: "{colors.surface-soft}"
      border: "1px solid {colors.border}"

   task-row-active:
      backgroundColor: "{colors.primary-weak}"
      textColor: "{colors.ink}"
      border: "1px solid {colors.primary-soft}"

   decision-card:
      backgroundColor: "{colors.surface}"
      textColor: "{colors.ink}"
      rounded: "{rounded.lg}"
      padding: "{spacing.xl}"
      border: "1px solid {colors.border}"
      shadow: "0 1px 2px rgba(15, 23, 42, 0.04)"

   decision-card-urgent:
      backgroundColor: "{colors.surface}"
      textColor: "{colors.ink}"
      border: "1px solid {colors.warning-soft}"

   evidence-card:
      backgroundColor: "{colors.surface}"
      textColor: "{colors.ink}"
      rounded: "{rounded.lg}"
      padding: "{spacing.md}"
      border: "1px solid {colors.border}"

   conclusion-card:
      backgroundColor: "{colors.success-weak}"
      textColor: "{colors.ink}"
      rounded: "{rounded.lg}"
      padding: "{spacing.xl}"
      border: "1px solid #BBF7D0"

   button-primary:
      backgroundColor: "{colors.primary}"
      textColor: "{colors.on-primary}"
      typography: "{typography.button}"
      rounded: "{rounded.md}"
      padding: "9px 14px"

   button-primary-hover:
      backgroundColor: "{colors.primary-hover}"
      textColor: "{colors.on-primary}"

   button-secondary:
      backgroundColor: "{colors.surface}"
      textColor: "{colors.ink}"
      typography: "{typography.button}"
      rounded: "{rounded.md}"
      padding: "9px 14px"
      border: "1px solid {colors.border-strong}"

   button-secondary-hover:
      backgroundColor: "{colors.surface-soft}"
      textColor: "{colors.ink}"

   button-ghost:
      backgroundColor: "transparent"
      textColor: "{colors.ink-muted}"
      typography: "{typography.button}"
      rounded: "{rounded.md}"
      padding: "8px 12px"

   badge-info:
      backgroundColor: "{colors.info-soft}"
      textColor: "{colors.info-strong}"
      typography: "{typography.caption-medium}"
      rounded: "{rounded.sm}"
      padding: "2px 8px"

   badge-success:
      backgroundColor: "{colors.success-soft}"
      textColor: "{colors.success-strong}"
      typography: "{typography.caption-medium}"
      rounded: "{rounded.sm}"
      padding: "2px 8px"

   badge-warning:
      backgroundColor: "{colors.warning-soft}"
      textColor: "{colors.warning-strong}"
      typography: "{typography.caption-medium}"
      rounded: "{rounded.sm}"
      padding: "2px 8px"

   badge-danger:
      backgroundColor: "{colors.danger-soft}"
      textColor: "{colors.danger-strong}"
      typography: "{typography.caption-medium}"
      rounded: "{rounded.sm}"
      padding: "2px 8px"

   progress-bar:
      backgroundColor: "{colors.surface-muted}"
      fillColor: "{colors.success}"
      height: 4px
      rounded: "{rounded.full}"

   text-input:
      backgroundColor: "{colors.surface}"
      textColor: "{colors.ink}"
      typography: "{typography.body}"
      rounded: "{rounded.md}"
      padding: "9px 12px"
      border: "1px solid {colors.border}"

   text-input-focused:
      backgroundColor: "{colors.surface}"
      textColor: "{colors.ink}"
      border: "1px solid {colors.focus-ring}"
      shadow: "0 0 0 3px rgba(147, 197, 253, 0.45)"

   code-card:
      backgroundColor: "{colors.code-surface}"
      textColor: "{colors.code-ink}"
      typography: "{typography.mono}"
      rounded: "{rounded.md}"
      padding: "{spacing.md}"

   artifact-preview:
      backgroundColor: "{colors.surface-soft}"
      textColor: "{colors.ink-muted}"
      rounded: "{rounded.md}"
      padding: "{spacing.md}"
      border: "1px solid {colors.border-soft}"
---

# Navia Operational Interface Design System

## Overview

Navia's interface is a light operational dashboard for supervising agentic engineering projects. The visual language is precise and calm: white cards, pale slate canvas, small semantic badges, compact task rows, and evidence previews. The layout direction is a workspace-level project list and a project-level cockpit with task clusters, pending decisions, and evidence artifacts.

This file defines only the interface design system. Architecture, ownership, storage, and product data-model decisions belong in separate documents.

## Token discipline and spec conformance

This file follows the [DESIGN.md](https://github.com/google-labs-code/design.md) format (front matter tokens + prose rationale). Validation is wired into prek; run it locally with:

```bash
pnpm dlx @google/design.md lint DESIGN.md
```

The **executable representation** of the YAML front matter lives at
[`apps/web/src/lib/tokens.css`](apps/web/src/lib/tokens.css). The CSS variable
layer is the single source of truth for runtime styling; component `<style>`
blocks must reference `var(--color-*)`, `var(--spacing-*)`, `var(--rounded-*)`,
`var(--shadow-*)` instead of hardcoded values. A pre-commit hook
(`no-hex-in-svelte`) blocks any new hex literal introduced inside a Svelte
`<style>` block.

When a token changes, update both DESIGN.md and `tokens.css` in the same
change.

Known deliberate deviations from the upstream spec, kept until the spec stabilises:

- **Component sub-tokens beyond the closed set.** The spec only recognises `backgroundColor / textColor / typography / rounded / padding / size / height / width`. Navia components also use `border` and `shadow` because the operational style relies on them for hierarchy. The linter accepts these with a warning. Do not remove them; do not extend the set further without updating this section.
- **`shadows` group.** The spec's reference resolver only resolves into the standard token groups, so `{shadows.*}` references will not link. Component shadows are inlined as literal `box-shadow` strings; the `shadows:` group remains as a documentation reference for the three canonical surfaces (card / popover / focus). Keep the inline values in sync with that group.
- **Orphaned color warnings.** The linter only detects token references when a token is assigned directly to a component property. Tokens used inside composite strings (`"1px solid {colors.border}"`) or referenced only from the prose are reported as orphaned. These warnings are expected and not actionable on a per-token basis.

When any of those become resolvable upstream, prefer the spec form and remove the corresponding deviation here.

## Visual theme and atmosphere

Navia should feel like an engineering command center, not an AI marketing site.

- **Light operational canvas.** The default background is pale slate (`{colors.canvas}`) with white surfaces.
- **Evidence-first hierarchy.** Reports, metrics, logs, patches, charts, and conclusions are the most visually important content.
- **Low decoration.** No gradient mesh, glassmorphism, heavy blur, or decorative AI glow.
- **Precise chrome.** Borders, compact radii, spacing, and small badges carry the interface rhythm.
- **Semantic color.** Color appears only when it communicates state, priority, or action.

## Color usage

### Primary action

Use `{colors.primary}` blue for primary buttons, active navigation, focus, links, and selected controls. Avoid using blue as a large background fill except for very soft selected states (`{colors.primary-weak}`).

### Status colors

- `{colors.success}`: verified, complete, accepted, healthy.
- `{colors.warning}`: pending decision, deadline risk, ambiguous state.
- `{colors.danger}`: blocked, failed, rejected, destructive.
- `{colors.info}`: running, neutral activity, selected task.
- `{colors.purple}`: optional agent/spec identity accent; keep rare.

### Neutral surfaces

Most UI should be neutral:

- page: `{colors.canvas}`;
- cards and panels: `{colors.surface}`;
- secondary previews: `{colors.surface-soft}`;
- borders: `{colors.border}` or `{colors.border-soft}`.

## Typography rules

Use Inter or Geist Sans for all dashboard UI. Use Geist Mono only for code, logs, diffs, hashes, IDs, and aligned metric values.

- Product dashboard headings should be restrained: `{typography.page-title}` is the usual maximum.
- Use `{typography.body}` for most interface text.
- Use `{typography.caption}` and `{typography.caption-medium}` for metadata, timestamps, versions, status pills, and provenance.
- Avoid weights above 600.
- Avoid large marketing typography inside the dashboard.

## Layout principles

### Workspace pages

Workspace pages use a two-region shell:

1. fixed left sidebar;
2. main content with top bar and optional right activity rail.

The Projects page should contain:

- metric cards at the top;
- searchable/filterable project list;
- recent activity rail;
- pagination or compact continuation controls.

### Project cockpit

Project pages use a three-column layout at desktop:

1. **Task execution overview** — grouped cluster cards and task rows.
2. **Decision inbox** — decision, approval, blocker, and review cards.
3. **Evidence board** — current conclusion and artifact preview cards.

At narrower widths, stack as:

1. decisions;
2. task overview;
3. evidence.

Decisions move first on tablet/mobile because unresolved human attention is usually the blocker.

## Component styling

### Sidebar

Use `{components.sidebar}` as the fixed navigation surface. Items use `{components.sidebar-item}` by default and `{components.sidebar-item-active}` when selected.

Active sidebar items must remain distinguishable under hover. Do not let hover override active state.

### Top bar

Use `{components.top-bar}` for breadcrumbs, notifications, share actions, account menu, and workspace/project context. Keep it quiet: no large title blocks inside the top bar.

### Stat cards

Use `{components.stat-card}` for workspace/project metrics.

A stat card contains:

- icon chip on the left;
- label in caption/body-medium;
- value in page-title or section-title;
- optional delta in caption.

Semantic icon chips may use soft backgrounds, but the card background remains white.

### Project list rows

Project rows are large compact cards or table-card hybrids. They should show:

- icon/avatar;
- project name and status badge;
- short category/description;
- participants/agent avatars;
- progress bar;
- pending decision count;
- artifact count;
- latest conclusion excerpt;
- update time;
- overflow menu.

Rows should use neutral borders and subtle hover only.

### Cluster cards

Cluster cards use `{components.cluster-card}`. Each cluster card contains a header with:

- cluster name;
- task count;
- collapse/expand affordance.

Task rows inside use `{components.task-row}`. Use a left state rail or small badge for task status; do not over-color the entire row.

### Decision cards

Decision cards use `{components.decision-card}`. Urgent items may use `{components.decision-card-urgent}` but still remain white.

A decision card must visually expose:

- decision ID;
- urgency badge;
- question;
- short context;
- source agent/cluster;
- related evidence;
- option buttons;
- deadline or age.

Primary option uses `{components.button-primary}`. Other options use secondary or ghost variants.

### Evidence cards

Evidence cards use `{components.evidence-card}`. They are preview surfaces for artifacts:

- reports;
- metric comparisons;
- logs;
- charts;
- patches;
- conclusion summaries.

Evidence cards should always include provenance metadata: version, updated time, source agent/run, or verification status.

### Current conclusion

Only the current trusted conclusion uses `{components.conclusion-card}`. This green-tinted surface is special; do not use it for ordinary success cards.

A conclusion card contains:

- status badge;
- conclusion title;
- short statement;
- confidence/trust fields;
- latest evidence count;
- next step.

### Logs and patches

Use `{components.code-card}` for dark log excerpts and `{components.artifact-preview}` for small neutral file previews.

Logs and diffs use mono typography. Avoid wrapping long lines when it harms readability; horizontal scroll is acceptable inside previews.

## Interaction states

### Hover

Hover is subtle:

- inactive sidebar item: soft background;
- task row: soft background and slightly stronger border;
- card: no scale, no heavy shadow;
- button: color/background change only.

### Active / selected

Selected items use one extra dimension beyond hover:

- active sidebar item: soft blue background + blue text + medium weight;
- active task row: soft blue background + blue border;
- selected filter: background + text color.

Active state must not visually degrade when hovered.

### Focus

All keyboard-focusable controls use the same blue focus ring (`{colors.focus-ring}`).

### Disabled

Disabled controls use `{colors.ink-disabled}` and reduced opacity. Do not invent separate disabled palettes.

## Do's

- Use white cards on a pale slate canvas.
- Use semantic color only for state and action.
- Make evidence previews visually concrete.
- Keep decision cards easy to scan.
- Use small badges for status and urgency.
- Show timestamps, versions, and source agents/runs on evidence.
- Prefer borders and spacing over shadows for hierarchy.

## Don'ts

- Do not put architecture or ownership decisions in this file.
- Do not use Astro/content-site visual assumptions for the dashboard.
- Do not use AI gradients, glassmorphism, neon glow, or decorative blobs.
- Do not make every agent or artifact a different bright color.
- Do not use red/orange/green decoratively.
- Do not hide evidence provenance.
- Do not use bold marketing typography inside dense dashboard surfaces.

## Responsive behavior

### Breakpoints

| Name    |       Width | Behavior                                                               |
| ------- | ----------: | ---------------------------------------------------------------------- |
| Desktop |    ≥ 1280px | Full sidebar + three-column project cockpit.                           |
| Laptop  | 1024–1279px | Keep sidebar; project cockpit may use two columns with evidence below. |
| Tablet  |  768–1023px | Sidebar can collapse; decisions stack before tasks/evidence.           |
| Mobile  |     < 768px | Single-column; sidebar becomes drawer; cards become full-width.        |

### Touch targets

Buttons and interactive rows should provide at least 40px effective height. Icon-only controls should be 32–40px depending on density, with clear focus state.

### Density

Do not simply enlarge everything on small screens. Preserve information hierarchy by stacking panels and keeping row/card internals compact.

## Agent usage contract

Agents should read this file before any Navia UI, layout, styling, component,
or visual review work. This file is the visual source of truth, not a product
architecture document.

When generating Navia UI:

1. Use this file only for visual/interface decisions.
2. Use `architecture-sketch.md` and `research-design-plan-report.md` for product/architecture decisions.
3. Build the dashboard direction: light surface, left nav, cards, decision queue, evidence board.
4. Use the front matter tokens instead of hardcoded colors, spacing, radii, typography, and shadows.
5. Keep UI operational and evidence-first.
6. Preserve the existing visual language when adding new components; extend tokens only when an existing token cannot express the needed state.
