import { describe, expect, it } from "vitest";
import {
  freshMessagePlatformFormValues,
  workspaceMessagePlatformConnections,
} from "./message-platform";

describe("freshMessagePlatformFormValues", () => {
  it("retains account settings without inventing a conversation binding", () => {
    expect(
      freshMessagePlatformFormValues({
        adapter: "infoflow",
        infoflowDefaultEndpoint: "https://api.im.baidu.com",
        feishuAppId: "cli_stored",
        infoflowAppKey: "stored-key",
        infoflowAppAgentId: "43163",
        qqbotAppId: "qq-stored",
        qqbotSandbox: true,
      }),
    ).toEqual({
      adapter: "infoflow",
      feishuAppId: "cli_stored",
      feishuAppSecret: "",
      infoflowEndpoint: "https://api.im.baidu.com",
      infoflowAppKey: "stored-key",
      infoflowAppAgentId: "43163",
      infoflowAppSecret: "",
      qqbotAppId: "qq-stored",
      qqbotClientSecret: "",
      qqbotSandbox: true,
    });
  });
});

describe("workspaceMessagePlatformConnections", () => {
  it("lists one account connection per configured adapter, independent of sessions", () => {
    expect(
      workspaceMessagePlatformConnections(
        {
          feishuEnabled: false,
          feishuAppId: "",
          infoflowEnabled: true,
          infoflowAppKey: "infoflow-key",
          infoflowAppAgentId: "43163",
          qqbotEnabled: true,
          qqbotAppId: "qq-app",
        },
        [
          { type: "infoflow", state: "connected" },
          { type: "qqbot", state: "reconnecting", error: "gateway unavailable" },
        ],
      ),
    ).toEqual([
      { adapter: "infoflow", accountId: "43163", runtimeState: "connected" },
      {
        adapter: "qqbot",
        accountId: "qq-app",
        runtimeState: "reconnecting",
        runtimeError: "gateway unavailable",
      },
    ]);
  });

  it("falls back to the Infoflow app key when no numeric app id is configured", () => {
    expect(
      workspaceMessagePlatformConnections({
        feishuEnabled: false,
        feishuAppId: "",
        infoflowEnabled: true,
        infoflowAppKey: "fallback-key",
        infoflowAppAgentId: "",
        qqbotEnabled: false,
        qqbotAppId: "",
      }),
    ).toEqual([{ adapter: "infoflow", accountId: "fallback-key" }]);
  });
});
