---
title: Getting started
description: Install Spark, configure a model, and complete a first foreground or interactive run.
sidebar:
  order: 2
---

## Requirements

Spark currently requires Node.js `>=26 <27`. The published product contains the
CLI dispatcher, native TUI, daemon, and Cockpit host.

## Install

The managed installation is recommended because it supports atomic upgrades
and rollback:

```bash
pnpm dlx @zendev-lab/spark install --managed
spark version --json
spark update status --json
```

You can instead keep the package manager in charge of the installation:

```bash
npm install --global @zendev-lab/spark
spark --help
```

Package-manager and source-checkout installations report update instructions
but never replace themselves.

Run the health check before troubleshooting a host:

```bash
spark doctor
```

## Configure a model

Open the interactive TUI:

```bash
spark
```

Use `/login` to inspect available provider authentication and start the
provider's interactive login flow. Use `/model` to inspect or select the active
model. When Spark prompts for an API key, enter it in the prompt; do not put
secrets in project files, `config.json`, or shell history.

## Complete a first run

For a foreground, non-interactive answer:

```bash
spark run "Summarize this repository and identify its validation command."
```

Use JSON mode for scripts:

```bash
spark run --json "List the top-level packages."
```

For an interactive session, stay in `spark` or run:

```bash
spark tui "Inspect the current project before proposing a change."
```

Spark starts or contacts the local daemon as needed. Run `spark daemon status
--json` to inspect the service rather than guessing from frontend behavior.

## Next steps

- Learn [which surface owns which behavior](/concepts/surfaces/).
- Choose between [foreground runs, background work, and sessions](/guides/runs-and-sessions/).
- Open the [Cockpit web surface](/guides/cockpit/).
