/** Runtime WebSocket context types. */

import type { DatabaseSync } from "node:sqlite";
import type { RawData } from "ws";

export interface RuntimeWebSocketContext {
  db: DatabaseSync;
  runtimeId: string;
  remoteAddress?: string;
  secureTransport?: boolean;
  heartbeatIntervalMs?: number;
}

export interface RuntimeWebSocketConnection {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: RawData) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
}

export interface RoutedContext {
  runtimeId?: string;
  workspaceBindingId?: string;
  workspaceId?: string;
  projectId?: string;
  commandId?: string;
  humanRequestId?: string;
  humanResponseId?: string;
  invocationId?: string;
  sessionId?: string;
}
