import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionRoleRunner } from "@zendev-lab/spark-extension-api";
import {
  createRoleNativeExecutorResolver,
  resolveSparkSourceHeadlessExecutorSpecifier,
} from "../packages/spark-roles/src/native-executor.ts";

function fakeRequest() {
  return {
    role: {
      ref: "role:builtin-worker" as const,
      id: "worker",
      systemPrompt: "work only",
    },
    instruction: {
      roleRef: "role:builtin-worker" as const,
      instruction: "do work",
    },
    record: {
      ref: "run:test" as const,
      roleRef: "role:builtin-worker" as const,
      instruction: "do work",
      status: "queued" as const,
    },
    cwd: process.cwd(),
    timeoutMs: 1_000,
  };
}

void test("role native executor source fallback bypasses extension-loader package aliases", async () => {
  const specifier = resolveSparkSourceHeadlessExecutorSpecifier();

  assert.match(specifier, /\/apps\/spark-tui\/src\/headless-role-executor\.ts$/u);
  const module = await import(specifier);
  assert.equal(typeof module.createSparkHeadlessRoleExecutor, "function");
});

void test("role native executor resolver prefers host-provided ctx.runRole", async () => {
  let loadCalls = 0;
  const provided: ExtensionRoleRunner = async (request) => ({
    record: { ...request.record, status: "succeeded" },
    stdout: "provided",
    stderr: "",
    jsonEvents: [],
  });
  const resolve = createRoleNativeExecutorResolver({
    loadHeadlessModule: async () => {
      loadCalls += 1;
      throw new Error("should not load fallback");
    },
  });

  const executor = await resolve({ runRole: provided });
  const result = await executor(fakeRequest());

  assert.equal(result.stdout, "provided");
  assert.equal(loadCalls, 0);
});

void test("role native executor resolver creates a cached headless fallback", async () => {
  let loadCalls = 0;
  let factoryCalls = 0;
  let executorCalls = 0;
  let loadedSpecifier: string | undefined;
  const resolve = createRoleNativeExecutorResolver({
    loadHeadlessModule: async (options) => {
      loadedSpecifier = options?.moduleSpecifier;
      loadCalls += 1;
      return {
        createSparkHeadlessSessionExecutor: () => async () => ({}),
        createSparkHeadlessRoleExecutor: () => {
          factoryCalls += 1;
          return async (request: Parameters<ExtensionRoleRunner>[0]) => {
            executorCalls += 1;
            return {
              record: { ...request.record, status: "succeeded" as const },
              stdout: "fallback",
              stderr: "",
              jsonEvents: [],
            };
          };
        },
      };
    },
  });

  const first = await resolve({});
  const second = await resolve({});
  assert.equal(first, second);

  const result = await first(fakeRequest());
  assert.equal(result.stdout, "fallback");
  assert.equal(loadCalls, 1);
  assert.match(loadedSpecifier ?? "", /\/apps\/spark-tui\/src\/headless-role-executor\.ts$/u);
  assert.equal(factoryCalls, 1);
  assert.equal(executorCalls, 1);
});

void test("role native executor resolver reports headless fallback load failures", async () => {
  const resolve = createRoleNativeExecutorResolver({
    loadHeadlessModule: async () => {
      throw new Error("missing headless package");
    },
  });

  const executor = await resolve({});
  await assert.rejects(
    () => executor(fakeRequest()),
    /daemon-native role executor load failed: missing headless package/u,
  );
});
