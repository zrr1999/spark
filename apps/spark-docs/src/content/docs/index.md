---
title: Spark Docs
description: User documentation for Spark across its CLI, TUI, daemon, and Cockpit surfaces.
template: splash
hero:
  tagline: Run coding-agent work in the foreground, hand durable work to the daemon, and supervise it from the terminal or Cockpit.
  actions:
    - text: Get started
      link: /getting-started/
      icon: right-arrow
    - text: CLI reference
      link: /reference/cli/
      icon: right-arrow
      variant: minimal
sidebar:
  order: 1
---

Spark is a controlled coding-agent suite with one public `spark` command and
three product surfaces:

- the **TUI** for interactive work,
- the **daemon** for durable sessions and background invocations, and
- **Cockpit** for web-based control and projection.

Start with [installation and your first run](/getting-started/). Read
[surfaces and ownership](/concepts/surfaces/) before automating Spark or
operating it remotely.

## What this documentation covers

- installing the published npm product,
- choosing foreground, background, TUI, or Cockpit workflows,
- resuming workspace-bound sessions,
- inspecting configuration and state paths, and
- diagnosing common local and remote-access failures.

The implementation repository remains the source of truth. User-facing command
examples in this site are checked against the source `spark --help` dispatcher.
