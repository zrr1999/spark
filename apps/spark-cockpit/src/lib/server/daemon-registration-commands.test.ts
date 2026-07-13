import { describe, expect, it } from "vitest";
import {
  buildDaemonLoginCommand,
  buildDaemonWorkspaceRegistrationCommand,
  isInsecureRemoteServerOrigin,
  isLoopbackServerOrigin,
} from "./daemon-registration-commands";

describe("daemon registration commands", () => {
  it("builds a reusable device login and tokenless workspace command", () => {
    expect(buildDaemonLoginCommand("https://spark.example.test")).toBe(
      "spark daemon login --server-url https://spark.example.test",
    );
    expect(
      buildDaemonWorkspaceRegistrationCommand({
        serverOrigin: "https://spark.example.test",
        displayName: "Model repro",
        workspaceName: "Model repro",
        workspaceSlug: "model-repro",
      }),
    ).toBe(
      "spark daemon workspace register . --server-url https://spark.example.test --name 'Model repro' --workspace-name 'Model repro' --workspace-slug model-repro",
    );
  });

  it("keeps one-time tokens on the compatible registration path", () => {
    expect(
      buildDaemonWorkspaceRegistrationCommand({
        serverOrigin: "http://127.0.0.1:5173",
        displayName: "spore",
        registrationToken: "spark_wsreg_test",
      }),
    ).toContain("--token spark_wsreg_test");
  });

  it("recognizes only loopback Cockpit origins", () => {
    expect(isLoopbackServerOrigin("http://127.0.0.1:5173")).toBe(true);
    expect(isLoopbackServerOrigin("http://localhost:5173")).toBe(true);
    expect(isLoopbackServerOrigin("http://192.168.1.8:5173")).toBe(false);
  });

  it("makes plaintext remote registration an explicit CLI acknowledgement", () => {
    const origin = "http://192.168.1.8:5173";
    expect(isInsecureRemoteServerOrigin(origin)).toBe(true);
    expect(buildDaemonLoginCommand(origin)).toContain("--allow-insecure-http");
    expect(
      buildDaemonWorkspaceRegistrationCommand({ serverOrigin: origin, displayName: "model-repro" }),
    ).toContain("--allow-insecure-http");
    expect(isInsecureRemoteServerOrigin("https://spark.example.test")).toBe(false);
  });
});
