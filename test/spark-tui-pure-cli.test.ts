import assert from "node:assert/strict";
import { test } from "vitest";

import { parseSparkCliCommand } from "../apps/spark-tui/src/cli.ts";

test("spark-tui rejects the removed server route with Cockpit guidance", () => {
  assert.deepEqual(parseSparkCliCommand(["server", "task", "list"]), {
    kind: "error",
    message: '"server" is not a spark-tui command. Use "spark cockpit" instead.',
  });
  assert.deepEqual(parseSparkCliCommand(["server", "instance", "status"]), {
    kind: "error",
    message: '"server" is not a spark-tui command. Use "spark cockpit" instead.',
  });
});
