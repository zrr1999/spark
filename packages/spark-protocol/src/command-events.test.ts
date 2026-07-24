import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  localRpcMethodToSparkCommandKind,
  parseSparkCommand,
  parseSparkEvent,
  runtimeEnvelopeTypeToSparkEventKind,
  runtimeServerCommandKindToSparkCommandKind,
  sparkCommandKindForLocalRpcMethod,
  sparkCommandKindForRuntimeServerCommand,
  sparkCommandSchema,
  sparkEventKindForRuntimeEnvelopeType,
  sparkEventSchema,
  type SparkCommand,
  type SparkEvent,
} from "./command-events.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "command-events-v1");
const vocabularySamples = readFixture("vocabulary-samples.json") as {
  commands: unknown[];
  events: unknown[];
};

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureDir, name), "utf8")) as unknown;
}

function transport(value: SparkCommand | SparkEvent) {
  return value.transport ?? { kind: "unknown" as const };
}

describe("SparkCommand vocabulary", () => {
  it("maps every observed local RPC method into a transport-neutral command kind", () => {
    expect(Object.keys(localRpcMethodToSparkCommandKind)).toEqual([
      "daemon.status",
      "daemon.stop",
      "daemon.restart",
      "turn.status",
      "turn.result",
      "turn.submit",
      "turn.cancel",
      "turn.stream",
      "invocation.list",
      "invocation.retry",
      "invocation.retention.preview",
      "driver.start",
      "driver.status",
      "driver.stop",
      "driver.restart",
      "driver.wake",
      "driver.schedule",
      "channel.status",
      "channel.configure",
      "channel.reload",
      "channel.notify",
      "workspace.list",
      "workspace.register",
      "workspace.relocate",
      "uplink.park",
      "uplink.unpark",
      "uplink.prefer",
      "uplink.status",
      "workspace.ensure-local",
      "workspace.attach",
      "workspace.stop",
      "workspace.client.attach",
      "workspace.client.heartbeat",
      "workspace.client.release",
      "workspace.executor.ensure",
      "workspace.transfer.pending",
      "workspace.transfer.respond",
      "session.list",
      "session.get",
      "session.snapshot",
      "session.create",
      "session.bind",
      "session.unbind",
      "session.archive",
      "session.send",
      "session.inbox",
      "session.mail.read",
      "session.mail.ack",
      "session.notification.deliver",
      "session.model.set",
      "session.thinking.set",
      "side-thread.ensure",
      "side-thread.snapshot",
      "side-thread.submit",
      "side-thread.reset",
      "side-thread.configure",
      "side-thread.handoff",
      "model.catalog",
      "model.default.set",
      "provider.auth.api-key.set",
      "provider.auth.logout",
      "provider.auth.login.start",
      "provider.auth.login.status",
      "provider.auth.login.respond",
      "provider.auth.login.cancel",
      "human.interaction.respond",
    ]);
    expect(sparkCommandKindForLocalRpcMethod("turn.submit")).toBe("turn.submit.request");
    expect(sparkCommandKindForLocalRpcMethod("daemon.restart")).toBe("daemon.restart.request");
    expect(sparkCommandKindForLocalRpcMethod("turn.cancel")).toBe("turn.cancel.request");
    expect(sparkCommandKindForLocalRpcMethod("turn.status")).toBe("turn.status.request");
    expect(sparkCommandKindForLocalRpcMethod("channel.configure")).toBe(
      "channel.configure.request",
    );
    expect(sparkCommandKindForLocalRpcMethod("workspace.register")).toBe(
      "workspace.register.request",
    );
    expect(sparkCommandKindForLocalRpcMethod("workspace.relocate")).toBe(
      "workspace.relocate.request",
    );
    expect(sparkCommandKindForRuntimeServerCommand("workspace.relocate.request")).toBeNull();
    expect(sparkCommandKindForLocalRpcMethod("session.create")).toBe("session.create.request");
    expect(sparkCommandKindForLocalRpcMethod("session.snapshot")).toBe("session.snapshot.request");
    expect(sparkCommandKindForLocalRpcMethod("session.model.set")).toBe(
      "session.model.set.request",
    );
    expect(sparkCommandKindForLocalRpcMethod("session.thinking.set")).toBe(
      "session.thinking.set.request",
    );
    expect(sparkCommandKindForLocalRpcMethod("side-thread.ensure")).toBe(
      "side-thread.ensure.request",
    );
    expect(sparkCommandKindForLocalRpcMethod("side-thread.handoff")).toBe(
      "side-thread.handoff.request",
    );
    expect(sparkCommandKindForLocalRpcMethod("model.catalog")).toBe("model.catalog.request");
    expect(sparkCommandKindForLocalRpcMethod("human.interaction.respond")).toBe(
      "human.response.deliver.request",
    );
    expect(sparkCommandKindForLocalRpcMethod("unknown.method")).toBeNull();
  });

  it("maps every runtime server.command kind into the same command vocabulary", () => {
    expect(Object.keys(runtimeServerCommandKindToSparkCommandKind)).toEqual([
      "daemon.status.request",
      "workspace.snapshot.request",
      "workspace.client.attach.request",
      "workspace.client.heartbeat.request",
      "workspace.client.release.request",
      "project.create.request",
      "task.start.request",
      "assignment.create.request",
      "session.list.request",
      "session.get.request",
      "session.snapshot.request",
      "session.media.read.request",
      "session.create.request",
      "session.bind.request",
      "session.unbind.request",
      "session.archive.request",
      "turn.submit.request",
      "turn.cancel.request",
      "turn.status.request",
      "turn.stream.subscribe",
      "session.model.set.request",
      "session.thinking.set.request",
      "side-thread.ensure.request",
      "side-thread.snapshot.request",
      "side-thread.submit.request",
      "side-thread.reset.request",
      "side-thread.configure.request",
      "side-thread.handoff.request",
      "model.catalog.request",
      "model.default.set.request",
      "provider.auth.logout.request",
      "provider.auth.login.start.request",
      "provider.auth.login.status.request",
      "provider.auth.login.cancel.request",
      "channel.status.request",
      "channel.reload.request",
      "invocation.cancel.request",
      "artifact.content.request",
      "human.response.deliver.request",
      "diagnostics.request",
    ]);
    expect(sparkCommandKindForRuntimeServerCommand("task.start.request")).toBe(
      "task.start.request",
    );
    expect(sparkCommandKindForRuntimeServerCommand("assignment.create.request")).toBe(
      "assignment.create.request",
    );
    expect(sparkCommandKindForRuntimeServerCommand("diagnostics.request")).toBe(
      "diagnostics.request",
    );
    expect(sparkCommandKindForRuntimeServerCommand("unknown.request")).toBeNull();
  });

  it("validates fixture commands from local RPC and runtime WebSocket transports", () => {
    const parsed = vocabularySamples.commands.map((command) => parseSparkCommand(command));

    expect(parsed.map((command) => command.kind)).toEqual([
      "daemon.restart.request",
      "turn.submit.request",
      "turn.cancel.request",
      "turn.status.request",
      "workspace.register.request",
      "workspace.snapshot.request",
      "task.start.request",
    ]);

    for (const command of parsed) {
      const source = transport(command);
      if (source.kind === "local-rpc") {
        expect(sparkCommandKindForLocalRpcMethod(source.method ?? "")).toBe(command.kind);
      }
      if (source.kind === "runtime-ws") {
        expect(sparkCommandKindForRuntimeServerCommand(source.sourceKind ?? "")).toBe(command.kind);
      }
      expect(parseSparkCommand(JSON.parse(JSON.stringify(command)))).toEqual(command);
    }
  });

  it("rejects unknown command intents", () => {
    expect(() =>
      sparkCommandSchema.parse({ schemaVersion: "spark.command.v1", kind: "turn.launch" }),
    ).toThrow();
  });
});

describe("SparkEvent vocabulary", () => {
  it("maps runtime envelope event types into SparkEvent facts", () => {
    expect(Object.keys(runtimeEnvelopeTypeToSparkEventKind)).toEqual([
      "runtime.command.ack",
      "runtime.command.reject",
      "runtime.command.result",
      "workspace.snapshot",
      "task_graph.snapshot",
      "artifact.projected",
      "invocation.updated",
      "invocation.log_chunk",
      "human.request.created",
      "human.response.recorded",
      "human.response.ack",
      "runtime.reconcile.report",
      "daemon.event",
    ]);
    expect(sparkEventKindForRuntimeEnvelopeType("runtime.command.ack")).toBe("command.accepted");
    expect(sparkEventKindForRuntimeEnvelopeType("runtime.command.reject")).toBe("command.rejected");
    expect(sparkEventKindForRuntimeEnvelopeType("runtime.command.result")).toBe("command.result");
    expect(sparkEventKindForRuntimeEnvelopeType("workspace.snapshot")).toBe(
      "projection.workspace.snapshot",
    );
    expect(sparkEventKindForRuntimeEnvelopeType("unknown.event")).toBeNull();
  });

  it("validates fixture events for command status, projections, diagnostics, and errors", () => {
    const parsed = vocabularySamples.events.map((event) => parseSparkEvent(event));

    expect(parsed.map((event) => event.kind)).toEqual([
      "command.accepted",
      "command.status",
      "projection.workspace.snapshot",
      "diagnostic.reported",
      "command.rejected",
      "error.reported",
    ]);
    expect(parsed.find((event) => event.kind === "diagnostic.reported")?.diagnostic?.code).toBe(
      "daemon.status",
    );
    expect(parsed.find((event) => event.kind === "error.reported")?.diagnostic?.severity).toBe(
      "error",
    );

    for (const event of parsed) {
      const source = transport(event);
      if (source.kind === "runtime-ws" && source.envelopeType !== "server.error") {
        expect(sparkEventKindForRuntimeEnvelopeType(source.envelopeType ?? "")).toBe(event.kind);
      }
      expect(parseSparkEvent(JSON.parse(JSON.stringify(event)))).toEqual(event);
    }
  });

  it("requires diagnostic details for diagnostic and error events", () => {
    expect(() =>
      sparkEventSchema.parse({ schemaVersion: "spark.event.v1", kind: "error.reported" }),
    ).toThrow(/must include diagnostic/u);
  });
});
