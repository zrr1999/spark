/**
 * Thin compatibility adapter for Spark host runtime internal types.
 *
 * Shared host-neutral types live in @zendev-lab/spark-host/types. This file
 * preserves the historical spark-tui host import path.
 */

export type {
  BuiltinEventName,
  EventListener,
  EventListenerMap,
  EventName,
  OutboxEnvelope,
  RegisteredCommand,
  RegisteredCommandMap,
  RegisteredTool,
  RegisteredToolMap,
  SparkDaemonEventListener,
  SparkHostCustomMessage,
  SparkHostMessageRenderer,
  SparkHostMessageRenderOptions,
  SparkHostModelRegistryLike,
  SparkHostRegistryModel,
  SparkHostRenderComponent,
  SparkHostRenderTheme,
  SparkHostSessionManagerStub,
  SparkHostUiTransport,
  ToolRegistrationListener,
} from "@zendev-lab/spark-host/types";
