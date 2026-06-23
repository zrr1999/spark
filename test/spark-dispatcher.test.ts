import assert from "node:assert/strict";
import test from "node:test";

import {
  helpText,
  parseSparkDispatcherArgs,
  runSparkDispatcher,
} from "../apps/spark-cli/src/cli.ts";

void test("parseSparkDispatcherArgs routes default, tui, daemon, and print commands", () => {
  assert.deepEqual(parseSparkDispatcherArgs([]), {
    kind: "dispatch",
    target: "tui",
    argv: [],
  });
  assert.deepEqual(parseSparkDispatcherArgs(["tui", "build", "this"]), {
    kind: "dispatch",
    target: "tui",
    argv: ["build", "this"],
  });
  assert.deepEqual(parseSparkDispatcherArgs(["daemon", "status", "--json"]), {
    kind: "dispatch",
    target: "daemon",
    argv: ["status", "--json"],
  });
  assert.deepEqual(parseSparkDispatcherArgs(["--print", "hello"]), {
    kind: "dispatch",
    target: "tui",
    argv: ["--print", "hello"],
  });
});

void test("parseSparkDispatcherArgs keeps help/version local and rejects unknown subcommands", () => {
  assert.deepEqual(parseSparkDispatcherArgs(["--help"]), { kind: "help" });
  assert.deepEqual(parseSparkDispatcherArgs(["version"]), { kind: "version" });
  const command = parseSparkDispatcherArgs(["build", "this"]);
  assert.equal(command.kind, "error");
  assert.match(command.kind === "error" ? command.message : "", /Unknown spark subcommand: build/u);
  assert.match(command.kind === "error" ? command.message : "", /spark tui build this/u);
});

void test("runSparkDispatcher invokes injected launcher with the selected target", async () => {
  const calls: Array<{ target: string; argv: string[] }> = [];
  const code = await runSparkDispatcher(
    ["daemon", "workspace", "ls"],
    {},
    {
      run: async (target, argv) => {
        calls.push({ target, argv });
        return 7;
      },
    },
  );

  assert.equal(code, 7);
  assert.deepEqual(calls, [{ target: "daemon", argv: ["workspace", "ls"] }]);
});

void test("runSparkDispatcher renders help and unknown-command diagnostics without dispatching", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const launcher = {
    run: async () => {
      throw new Error("should not dispatch");
    },
  };

  assert.equal(
    await runSparkDispatcher(
      ["--help"],
      {
        stdout: {
          write: (text) => {
            stdout.push(String(text));
            return true;
          },
        },
      },
      launcher,
    ),
    0,
  );
  assert.equal(stdout.join(""), helpText());

  assert.equal(
    await runSparkDispatcher(
      ["unknown"],
      {
        stderr: {
          write: (text) => {
            stderr.push(String(text));
            return true;
          },
        },
      },
      launcher,
    ),
    2,
  );
  assert.match(stderr.join(""), /Unknown spark subcommand: unknown/u);
});
