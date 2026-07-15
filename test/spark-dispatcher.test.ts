import assert from "node:assert/strict";
import test from "node:test";

import {
  helpText,
  parseSparkDispatcherArgs,
  resolveTargetCommand,
  runSparkDispatcher,
} from "../apps/spark-cli/src/cli.ts";

void test("parseSparkDispatcherArgs routes default, tui, daemon, cockpit, sessions, and print commands", () => {
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
  const removedServer = parseSparkDispatcherArgs(["server", "status"]);
  assert.equal(removedServer.kind, "error");
  assert.match(removedServer.kind === "error" ? removedServer.message : "", /spark cockpit/u);
  assert.deepEqual(parseSparkDispatcherArgs(["cockpit", "--port", "5174"]), {
    kind: "dispatch",
    target: "cockpit",
    argv: ["--port", "5174"],
  });
  assert.deepEqual(parseSparkDispatcherArgs(["sessions", "list", "--all-workspaces"]), {
    kind: "dispatch",
    target: "tui",
    argv: ["sessions", "list", "--all-workspaces"],
  });
  assert.deepEqual(parseSparkDispatcherArgs(["session", "replay", "--session", "s1"]), {
    kind: "dispatch",
    target: "tui",
    argv: ["session", "replay", "--session", "s1"],
  });
  assert.deepEqual(parseSparkDispatcherArgs(["--print", "hello"]), {
    kind: "dispatch",
    target: "tui",
    argv: ["--print", "hello"],
  });
  assert.deepEqual(parseSparkDispatcherArgs(["--mode", "json", "--print", "hello"]), {
    kind: "dispatch",
    target: "tui",
    argv: ["--mode", "json", "--print", "hello"],
  });
  assert.deepEqual(parseSparkDispatcherArgs(["run", "--json", "--resume", "s1", "hello"]), {
    kind: "dispatch",
    target: "tui",
    argv: ["--print", "--mode", "json", "--session", "s1", "hello"],
  });
  assert.deepEqual(parseSparkDispatcherArgs(["paths", "--json"]), {
    kind: "paths",
    json: true,
  });
  assert.deepEqual(parseSparkDispatcherArgs(["doctor", "--json"]), {
    kind: "dispatch",
    target: "daemon",
    argv: ["doctor", "--json"],
  });
  assert.deepEqual(parseSparkDispatcherArgs(["bg", "--json", "hello"]), {
    kind: "dispatch",
    target: "daemon",
    argv: ["submit", "--json", "hello"],
    autoSessionPrefix: "spark-bg",
  });
  assert.deepEqual(parseSparkDispatcherArgs(["bg", "--session", "s1", "hello"]), {
    kind: "dispatch",
    target: "daemon",
    argv: ["submit", "--session", "s1", "hello"],
  });
  assert.deepEqual(parseSparkDispatcherArgs(["install", "./skill", "--skill"]), {
    kind: "dispatch",
    target: "tui",
    argv: ["install", "./skill", "--skill"],
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

void test("spark paths reports one SPARK_HOME without dispatching or writing", async () => {
  const previousSparkHome = process.env.SPARK_HOME;
  const root = `/tmp/spark-paths-${process.pid}-${Date.now()}`;
  const stdout: string[] = [];
  let dispatched = false;
  process.env.SPARK_HOME = root;
  try {
    const code = await runSparkDispatcher(
      ["paths", "--json"],
      {
        stdout: {
          write: (text) => {
            stdout.push(String(text));
            return true;
          },
        },
      },
      {
        run: async () => {
          dispatched = true;
          return 1;
        },
      },
    );

    assert.equal(code, 0);
    assert.equal(dispatched, false);
    const paths = JSON.parse(stdout.join("")) as {
      sparkHome: string;
      user: { roleModelSettingsFile: string; memoryFile: string };
      daemon: { databasePath: string };
      cockpit: { cacheDir: string };
    };
    assert.equal(paths.sparkHome, root);
    assert.equal(paths.user.roleModelSettingsFile, `${root}/role-model-settings.json`);
    assert.equal(paths.user.memoryFile, `${root}/memory/memory.json`);
    assert.equal(paths.daemon.databasePath, `${root}/apps/daemon/data/daemon.sqlite`);
    assert.equal(paths.cockpit.cacheDir, `${root}/apps/cockpit/cache`);
  } finally {
    if (previousSparkHome === undefined) delete process.env.SPARK_HOME;
    else process.env.SPARK_HOME = previousSparkHome;
  }
});

void test("dispatcher resolves daemon plane through spark-tui adapter", () => {
  const command = resolveTargetCommand("daemon");
  assert.match(command.command, /spark-tui(?:$|\/bin\/spark-tui$)/u);
  assert.deepEqual(command.args, ["daemon"]);
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

void test("runSparkDispatcher fails fast for non-TTY TUI while preserving headless shims", async () => {
  const stderr: string[] = [];
  const calls: Array<{ target: string; argv: string[] }> = [];
  const io = {
    stdin: { isTTY: false },
    stdout: { isTTY: true, write: () => true },
    stderr: {
      write: (text: string) => {
        stderr.push(text);
        return true;
      },
    },
  };
  const launcher = {
    run: async (target: "tui" | "daemon" | "server" | "cockpit", argv: string[]) => {
      calls.push({ target, argv });
      return 0;
    },
  };

  assert.equal(await runSparkDispatcher([], io, launcher), 2);
  assert.deepEqual(calls, []);
  assert.match(stderr.join(""), /requires an interactive terminal/u);
  assert.match(stderr.join(""), /spark --print <prompt>/u);

  assert.equal(await runSparkDispatcher(["--print", "hello"], io, launcher), 0);
  assert.equal(await runSparkDispatcher(["tui", "--help"], io, launcher), 0);
  assert.equal(await runSparkDispatcher(["run", "--json", "hello"], io, launcher), 0);
  assert.equal(await runSparkDispatcher(["tui", "--mode", "rpc"], io, launcher), 0);
  assert.equal(await runSparkDispatcher(["sessions", "list"], io, launcher), 0);
  assert.deepEqual(calls, [
    { target: "tui", argv: ["--print", "hello"] },
    { target: "tui", argv: ["--help"] },
    { target: "tui", argv: ["--print", "--mode", "json", "hello"] },
    { target: "tui", argv: ["--mode", "rpc"] },
    { target: "tui", argv: ["sessions", "list"] },
  ]);
});

void test("runSparkDispatcher generates a daemon session id for spark bg", async () => {
  const calls: Array<{ target: string; argv: string[] }> = [];
  const code = await runSparkDispatcher(
    ["bg", "ship", "it"],
    {},
    {
      run: async (target, argv) => {
        calls.push({ target, argv });
        return 0;
      },
    },
  );

  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.target, "daemon");
  assert.equal(calls[0]?.argv[0], "submit");
  assert.equal(calls[0]?.argv[1], "--session");
  assert.match(calls[0]?.argv[2] ?? "", /^spark-bg-/u);
  assert.deepEqual(calls[0]?.argv.slice(3), ["ship", "it"]);
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
