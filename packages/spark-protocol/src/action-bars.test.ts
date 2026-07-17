import { describe, expect, it } from "vitest";
import {
  parseSparkSlashInput,
  resolveSparkSlashEditorInput,
  sparkActionBarViewSchema,
  sparkActionViewSchema,
  sparkSlashActionBarCatalog,
  sparkSlashActionBarForInput,
  sparkSlashCommandDescriptors,
} from "./action-bars.ts";

describe("Spark action-bar protocol", () => {
  it("derives the compatible lookup catalog from unique canonical commands and aliases", () => {
    expect(sparkSlashCommandDescriptors.map((descriptor) => descriptor.name)).toEqual([
      "model",
      "thinking",
      "settings",
      "status",
      "session",
      "queue",
      "scoped-models",
      "goal",
      "loop",
      "repro",
      "workflow-runs",
      "help",
      "hotkeys",
    ]);

    const lookupNames = sparkSlashCommandDescriptors.flatMap((descriptor) => [
      descriptor.name,
      ...descriptor.aliases,
    ]);
    expect(new Set(lookupNames).size).toBe(lookupNames.length);
    expect(Object.keys(sparkSlashActionBarCatalog)).toEqual(lookupNames);

    for (const descriptor of sparkSlashCommandDescriptors) {
      expect(sparkSlashActionBarCatalog[descriptor.name]).toBe(descriptor.actionBar);
      for (const alias of descriptor.aliases) {
        expect(sparkSlashActionBarCatalog[alias]).toBe(descriptor.actionBar);
      }

      const serialized = JSON.stringify(descriptor.actionBar);
      expect(sparkActionBarViewSchema.parse(JSON.parse(serialized))).toEqual(descriptor.actionBar);
      expect(serialized).not.toMatch(/"(?:slash|cli|command)"\s*:/u);
      expect(serialized).not.toContain("spark tui");
      expect(serialized).not.toContain("spark daemon");
      expect(serialized).not.toContain("spark cockpit");
    }
  });

  it("offers canonical commands for an empty query and deterministic prefix matches", () => {
    const all = resolveSparkSlashEditorInput("/");
    expect(all.kind).toBe("suggest");
    if (all.kind !== "suggest") throw new Error("Expected slash suggestions");
    expect(all.suggestions.map((suggestion) => suggestion.command)).toEqual(
      sparkSlashCommandDescriptors.map((descriptor) => descriptor.name),
    );
    expect(
      all.suggestions.every(
        (suggestion) => !suggestion.descriptor.aliases.includes(suggestion.command),
      ),
    ).toBe(true);

    const canonicalPrefix = resolveSparkSlashEditorInput("/SE");
    expect(canonicalPrefix).toMatchObject({
      kind: "suggest",
      query: "se",
      suggestions: [
        { command: "settings", canonicalCommand: "settings" },
        { command: "session", canonicalCommand: "session" },
      ],
    });

    const mixedPrefix = resolveSparkSlashEditorInput("/r");
    expect(mixedPrefix).toMatchObject({
      kind: "suggest",
      query: "r",
      suggestions: [
        { command: "repro", canonicalCommand: "repro" },
        { command: "resume", canonicalCommand: "session" },
        { command: "runs", canonicalCommand: "workflow-runs" },
      ],
    });
  });

  it("hands exact canonical names and aliases to their action bar before prefix completion", () => {
    const canonical = resolveSparkSlashEditorInput(" /MODEL ");
    expect(canonical).toMatchObject({
      kind: "exact",
      command: "model",
      descriptor: { name: "model", actionBar: { id: "model" } },
    });

    const alias = resolveSparkSlashEditorInput("/run");
    expect(alias).toMatchObject({
      kind: "exact",
      command: "run",
      descriptor: { name: "workflow-runs", actionBar: { id: "workflow-runs" } },
    });
    expect(resolveSparkSlashEditorInput("/NEW")).toMatchObject({
      kind: "exact",
      command: "new",
      descriptor: { name: "session", actionBar: { id: "session" } },
    });
  });

  it("separates ordinary text, escaped text, unknown names, and command arguments", () => {
    expect(resolveSparkSlashEditorInput("ordinary prompt")).toEqual({ kind: "inactive" });
    expect(resolveSparkSlashEditorInput("//model")).toEqual({ kind: "inactive" });
    expect(resolveSparkSlashEditorInput("please /model")).toEqual({ kind: "inactive" });
    expect(resolveSparkSlashEditorInput("/not-a-command")).toEqual({
      kind: "unknown",
      command: "not-a-command",
    });
    expect(resolveSparkSlashEditorInput("/model OpenAI/GPT-5")).toMatchObject({
      kind: "arguments",
      command: "model",
      args: "OpenAI/GPT-5",
      descriptor: { name: "model" },
    });
    expect(resolveSparkSlashEditorInput("/not-a-command value")).toEqual({
      kind: "arguments",
      command: "not-a-command",
      args: "value",
    });
  });

  it("uses semantic intents and payloads instead of executable text", () => {
    const thinking = sparkSlashActionBarForInput("/thinking");
    expect(thinking?.actions.map((action) => action.intent)).toEqual([
      "thinking.select",
      "thinking.select",
      "thinking.select",
      "thinking.select",
      "thinking.select",
      "thinking.select",
    ]);
    expect(thinking?.actions.at(-1)?.payload).toEqual({ thinkingLevel: "xhigh" });
    expect(sparkSlashActionBarForInput("/queue")?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ intent: "queue.inspect" }),
        expect.objectContaining({ intent: "turn.stop", tone: "danger" }),
        expect.objectContaining({ intent: "turn.retry" }),
      ]),
    );
  });

  it("maps aliases to the same session operation surface", () => {
    const session = sparkSlashActionBarForInput("/session");
    expect(sparkSlashActionBarForInput("/sessions")).toBe(session);
    expect(sparkSlashActionBarForInput("/resume")).toBe(session);
    expect(sparkSlashActionBarForInput("/new")).toBe(session);
    expect(session?.actions.map((action) => action.intent)).toEqual([
      "session.select",
      "session.create",
      "session.inspect",
    ]);
  });

  it("publishes lifecycle controls and workflow run actions as typed intents", () => {
    for (const resource of ["goal", "loop", "repro"] as const) {
      expect(sparkSlashActionBarForInput(`/${resource}`)?.actions).toEqual([
        expect.objectContaining({ intent: `${resource}.status`, tone: "primary" }),
        expect.objectContaining({ intent: `${resource}.start` }),
        expect.objectContaining({ intent: `${resource}.restart` }),
        expect.objectContaining({ intent: `${resource}.stop`, tone: "danger" }),
      ]);
    }
    expect(
      sparkSlashActionBarForInput("/workflow-runs")?.actions.map((action) => action.intent),
    ).toEqual(["workflow.open", "workflow.inspect"]);

    const workflowRuns = sparkSlashActionBarForInput("/workflow-runs");
    expect(sparkSlashActionBarForInput("/runs")).toBe(workflowRuns);
    expect(sparkSlashActionBarForInput("/run")).toBe(workflowRuns);
    expect(sparkSlashActionBarForInput("/workflows")).toBe(workflowRuns);
  });

  it("only opens a catalog bar for an exact argument-free slash command", () => {
    expect(sparkSlashActionBarForInput(" /MODEL \n")?.id).toBe("model");
    expect(sparkSlashActionBarForInput("/new")?.id).toBe("session");
    expect(sparkSlashActionBarForInput("/runs")?.id).toBe("workflow-runs");
    expect(sparkSlashActionBarForInput("/run")?.id).toBe("workflow-runs");
    expect(sparkSlashActionBarForInput("/workflows")?.id).toBe("workflow-runs");
    expect(sparkSlashActionBarForInput("/model openai/gpt-5")).toBeUndefined();
    expect(sparkSlashActionBarForInput("/settings set thinking high")).toBeUndefined();
    expect(sparkSlashActionBarForInput("//model")).toBeUndefined();
    expect(sparkSlashActionBarForInput("please /model")).toBeUndefined();
    expect(sparkSlashActionBarForInput("/unknown")).toBeUndefined();
    expect(sparkSlashActionBarForInput("/")).toBeUndefined();
  });

  it("parses names and arguments without assigning an execution target", () => {
    expect(parseSparkSlashInput(" /workflow:review   run:123 ")).toEqual({
      command: "workflow:review",
      args: "run:123",
    });
    expect(parseSparkSlashInput("/scoped-models")).toEqual({
      command: "scoped-models",
      args: "",
    });
    expect(parseSparkSlashInput("//escaped")).toBeUndefined();
  });

  it("rejects unknown descriptor fields, non-JSON payloads, and duplicate action ids", () => {
    expect(
      sparkActionViewSchema.safeParse({
        id: "model",
        label: "Model",
        intent: "model.select",
        payload: {},
        slash: "/model",
      }).success,
    ).toBe(false);
    expect(
      sparkActionViewSchema.safeParse({
        id: "model",
        label: "Model",
        intent: "model.select",
        payload: { callback: () => undefined },
      }).success,
    ).toBe(false);
    expect(
      sparkActionBarViewSchema.safeParse({
        id: "duplicate",
        title: "Duplicate",
        actions: [
          { id: "same", label: "First", intent: "status.inspect", payload: {} },
          { id: "same", label: "Second", intent: "queue.inspect", payload: {} },
        ],
      }).success,
    ).toBe(false);
  });
});
