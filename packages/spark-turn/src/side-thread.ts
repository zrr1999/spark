/** Host-neutral state and handoff primitives for an isolated side conversation. */

export type SparkSideThreadMode = "contextual" | "tangent";

export interface SparkSideThreadHandoffExchange {
  user: string;
  assistant: string;
}

export interface SparkSideThreadState<
  TExchange,
  TModelOverride = unknown,
  TThinkingOverride = string,
> {
  mode: SparkSideThreadMode;
  exchanges: TExchange[];
  modelOverride: TModelOverride | null;
  thinkingOverride: TThinkingOverride | null;
}

export type SparkSideThreadEvent<TExchange, TModelOverride = unknown, TThinkingOverride = string> =
  | { kind: "reset"; mode?: SparkSideThreadMode }
  | { kind: "append"; exchange: TExchange }
  | { kind: "model_override"; value: TModelOverride | null }
  | { kind: "thinking_override"; value: TThinkingOverride | null };

export function createSparkSideThreadState<
  TExchange,
  TModelOverride = unknown,
  TThinkingOverride = string,
>(): SparkSideThreadState<TExchange, TModelOverride, TThinkingOverride> {
  return {
    mode: "contextual",
    exchanges: [],
    modelOverride: null,
    thinkingOverride: null,
  };
}

export function applySparkSideThreadEvent<
  TExchange,
  TModelOverride = unknown,
  TThinkingOverride = string,
>(
  state: SparkSideThreadState<TExchange, TModelOverride, TThinkingOverride>,
  event: SparkSideThreadEvent<TExchange, TModelOverride, TThinkingOverride>,
): SparkSideThreadState<TExchange, TModelOverride, TThinkingOverride> {
  switch (event.kind) {
    case "reset":
      return {
        ...state,
        mode: event.mode ?? "contextual",
        exchanges: [],
      };
    case "append":
      return {
        ...state,
        exchanges: [...state.exchanges, event.exchange],
      };
    case "model_override":
      return { ...state, modelOverride: event.value };
    case "thinking_override":
      return { ...state, thinkingOverride: event.value };
  }
}

export function reduceSparkSideThreadEvents<
  TExchange,
  TModelOverride = unknown,
  TThinkingOverride = string,
>(
  events: Iterable<SparkSideThreadEvent<TExchange, TModelOverride, TThinkingOverride>>,
  initialState = createSparkSideThreadState<TExchange, TModelOverride, TThinkingOverride>(),
): SparkSideThreadState<TExchange, TModelOverride, TThinkingOverride> {
  let state = initialState;
  for (const event of events) state = applySparkSideThreadEvent(state, event);
  return state;
}

export function formatSparkSideThreadHandoff(
  exchanges: readonly SparkSideThreadHandoffExchange[],
): string {
  return exchanges
    .map((exchange) => {
      const user = exchange.user.trim();
      const assistant = exchange.assistant.trim();
      return `User: ${user}\nAssistant: ${assistant}`;
    })
    .join("\n\n---\n\n");
}
