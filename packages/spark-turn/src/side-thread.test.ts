import assert from "node:assert/strict";
import fc from "fast-check";
import { test } from "vitest";

import {
  formatSparkSideThreadHandoff,
  reduceSparkSideThreadEvents,
  type SparkSideThreadEvent,
} from "./side-thread.ts";

type Exchange = { id: number };
type Event = SparkSideThreadEvent<Exchange, string, string>;

test("reset clears only the side conversation and preserves independent overrides", () => {
  const restored = reduceSparkSideThreadEvents<Exchange, string, string>([
    { kind: "model_override", value: "fast-model" },
    { kind: "append", exchange: { id: 1 } },
    { kind: "thinking_override", value: "low" },
    { kind: "reset", mode: "tangent" },
    { kind: "append", exchange: { id: 2 } },
  ]);

  assert.deepEqual(restored, {
    mode: "tangent",
    exchanges: [{ id: 2 }],
    modelOverride: "fast-model",
    thinkingOverride: "low",
  });
});

test("event reduction matches the side-thread persistence model for arbitrary histories", () => {
  const event: fc.Arbitrary<Event> = fc.oneof(
    fc.constantFrom<Event>(
      { kind: "reset" },
      { kind: "reset", mode: "contextual" },
      { kind: "reset", mode: "tangent" },
    ),
    fc.integer().map((id): Event => ({ kind: "append", exchange: { id } })),
    fc
      .option(fc.string(), { nil: null })
      .map((value): Event => ({ kind: "model_override", value })),
    fc
      .option(fc.string(), { nil: null })
      .map((value): Event => ({ kind: "thinking_override", value })),
  );

  fc.assert(
    fc.property(fc.array(event), (events) => {
      let mode: "contextual" | "tangent" = "contextual";
      let exchanges: Exchange[] = [];
      let modelOverride: string | null = null;
      let thinkingOverride: string | null = null;

      for (const item of events) {
        switch (item.kind) {
          case "reset":
            mode = item.mode ?? "contextual";
            exchanges = [];
            break;
          case "append":
            exchanges.push(item.exchange);
            break;
          case "model_override":
            modelOverride = item.value;
            break;
          case "thinking_override":
            thinkingOverride = item.value;
            break;
        }
      }

      const actual = reduceSparkSideThreadEvents(events);
      assert.deepEqual(actual, { mode, exchanges, modelOverride, thinkingOverride });
    }),
  );
});

test("handoff formatting is deterministic and trims adapter-owned whitespace", () => {
  assert.equal(
    formatSparkSideThreadHandoff([
      { user: "  first question ", assistant: " first answer\n" },
      { user: "second question", assistant: "second answer" },
    ]),
    "User: first question\nAssistant: first answer\n\n---\n\nUser: second question\nAssistant: second answer",
  );
});
