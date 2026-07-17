import {
  createQqbotTransport as createDefaultQqbotTransport,
  type ChannelAdapterConfig,
  type ChannelTransport,
  type QqbotAdapterConfig,
  type QqbotTransportOptions,
} from "@zendev-lab/spark-channels";
import type { DatabaseSync } from "node:sqlite";
import { SparkQqbotGatewayCursorStore } from "../store/qqbot-gateway-cursors.ts";

export interface DaemonChannelTransportContext {
  workspaceId: string;
  adapterId: string;
  config: ChannelAdapterConfig;
}

export type DaemonChannelTransportFactory = (
  context: DaemonChannelTransportContext,
) => ChannelTransport | undefined;

export interface DaemonChannelTransportFactoryOptions {
  cursorStore?: SparkQqbotGatewayCursorStore;
  createQqbotTransport?: (
    config: QqbotAdapterConfig,
    options: QqbotTransportOptions,
  ) => ChannelTransport;
}

/** Keep workspace identity and SQLite ownership out of spark-channels. */
export function createDaemonChannelTransportFactory(
  db: DatabaseSync,
  options: DaemonChannelTransportFactoryOptions = {},
): DaemonChannelTransportFactory {
  const cursors = options.cursorStore ?? new SparkQqbotGatewayCursorStore(db);
  const createQqbot = options.createQqbotTransport ?? createDefaultQqbotTransport;
  return ({ workspaceId, adapterId, config }) => {
    if (config.type !== "qqbot") return undefined;
    return createQqbot(config, {
      loadCursor: () => cursors.get(workspaceId, adapterId) ?? null,
      saveCursor: (cursor) => cursors.save(workspaceId, adapterId, cursor),
    });
  };
}
