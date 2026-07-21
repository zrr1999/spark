/** Host UI transport adapter over SparkNativeTuiApp + session. */

import { parseSparkInteractionRequest } from "@zendev-lab/spark-protocol";
import type { SparkHostUiTransport } from "../host/types.ts";
import type { SparkNativeTuiApp } from "./app.ts";
import type { SparkNativeSession } from "./session.ts";

export function createSparkNativeUiTransport(
  app: SparkNativeTuiApp,
  session: SparkNativeSession,
): SparkHostUiTransport {
  return {
    notify: (message: string, level?: "info" | "warning" | "error" | "success") =>
      session.addCustomMessage({
        customType: "notification",
        content: `${level ?? "info"}: ${message}`,
        display: true,
      }),
    setStatus: (key, text) => app.setStatus(key, text),
    setWidget: (key, callback, options) => app.setWidget(key, callback, options),
    setEditorText: (text) => app.setEditorText(text),
    customMessage: (message) =>
      session.addCustomMessage({
        customType: message.customType,
        content:
          typeof message.content === "string" ? message.content : JSON.stringify(message.content),
        display: message.display,
        details: message.details,
      }),
    custom: (...args: unknown[]) =>
      app.custom(args[0] as Parameters<typeof app.custom>[0], args[1]),
    interaction: (request) => app.handleInteractionRequest(parseSparkInteractionRequest(request)),
    publishView: (event) => app.applyViewModelEvent(event),
  };
}
