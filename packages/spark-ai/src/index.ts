import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  ModelThinkingLevel,
  ProviderId,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
export type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  Usage,
} from "@earendil-works/pi-ai";

export type SparkModelId = string;
export type ProviderRouteId = string;
export type AuthPoolId = string;
export type AuthSlotId = string;

export type SparkModelInputModality = "text" | "image";

export interface SparkModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SparkModelCapabilities {
  input: SparkModelInputModality[];
  reasoning: boolean;
  toolUse?: boolean;
}

export interface SparkModelIdentity {
  api?: Api;
  provider?: ProviderId;
  model?: string;
}

export interface ResolvedSparkModelIdentity {
  api: Api;
  provider: ProviderId;
  model: string;
}

/**
 * Stable Spark-facing model identity selected by users and agents.
 *
 * A profile binds one Spark model id to one or more provider transport routes.
 * The profile id is the user-visible model key; route ids/providers/transport APIs
 * are routing details and must not be required at model-selection time.
 */
export interface SparkModelProfile {
  id: SparkModelId;
  name: string;
  description?: string;
  capabilities: SparkModelCapabilities;
  cost: SparkModelCost;
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: ThinkingLevelMap;
  defaultThinkingLevel?: ModelThinkingLevel;
  identity?: SparkModelIdentity;
  routes: ProviderRoute[];
  authPools?: SparkAuthPool[];
  metadata?: Record<string, unknown>;
}

/**
 * One concrete upstream transport binding for a Spark model.
 *
 * `transportApi` and `transportModelId` are the runtime values passed to pi-ai;
 * the containing SparkModelProfile remains the Spark-facing identity reported in
 * UI/trace results. `authPoolId` chooses the credential slot pool for this route.
 */
export interface ProviderRoute<TApi extends Api = Api> {
  id: ProviderRouteId;
  provider: ProviderId;
  label?: string;
  priority: number;
  enabled?: boolean;
  transportApi: TApi;
  transportModelId: string;
  baseUrl: string;
  authPoolId: AuthPoolId;
  headers?: Record<string, string>;
  compat?: Model<TApi>["compat"];
  metadata?: Record<string, unknown>;
}

export interface SparkAuthPool {
  id: AuthPoolId;
  label?: string;
  slots: AuthSlot[];
  metadata?: Record<string, unknown>;
}

export interface AuthSlot {
  id: AuthSlotId;
  authRef: SparkAuthRef;
  label?: string;
  priority: number;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
}

export type SparkAuthRef =
  | { kind: "env"; name: string }
  | { kind: "secret"; id: string }
  | { kind: "provider"; id: string };

export type FailureClass =
  | "auth"
  | "rate_limit"
  | "context_overflow"
  | "provider_mismatch"
  | "transient"
  | "fatal"
  | "aborted";

export type RouteHealthStatus =
  | "unknown"
  | "ok"
  | "disabled"
  | "cooldown"
  | "degraded"
  | "stale_auth";

export interface RouteHealth {
  status: RouteHealthStatus;
  reason?: string;
  inflight?: number;
  consecutiveFailures?: number;
  lastUsedAt?: string;
  cooldownUntil?: string;
}

export type RouteDecisionReason =
  | "ordered_available"
  | "sticky_available"
  | "failover_available"
  | "capability_mismatch"
  | "no_available_route";

export interface RouteDecision {
  profileId: SparkModelId;
  routeId: ProviderRouteId;
  authPoolId: AuthPoolId;
  authSlotId?: AuthSlotId;
  reason: RouteDecisionReason;
  route: ProviderRoute;
  authSlot?: AuthSlot;
  sticky?: boolean;
  trace: RouteTrace;
}

export type RouteTraceEventType =
  | "CANDIDATE_POOL"
  | "CANDIDATE_SKIP"
  | "CANDIDATE_START"
  | "REQUEST_FINAL";

export interface RouteTraceEvent {
  type: RouteTraceEventType;
  at: string;
  profileId: SparkModelId;
  routeId?: ProviderRouteId;
  authPoolId?: AuthPoolId;
  authSlotId?: AuthSlotId;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface RouteTrace {
  events: RouteTraceEvent[];
  maxEvents: number;
}

export interface FailurePolicyHint {
  retriable: boolean;
  cooldown: boolean;
  failover: boolean;
}

export interface ProviderFailureInput {
  error?: unknown;
  message?: unknown;
  assistantMessage?: unknown;
  status?: number;
  stopReason?: string;
  errorMessage?: string;
}

export interface ProviderFailureClassification {
  failureClass: FailureClass;
  policy: FailurePolicyHint;
  message: string;
  status?: number;
}

export interface SparkAuthSlotPoolClock {
  now(): number;
}

export interface SparkAuthSlotPoolOptions {
  clock?: SparkAuthSlotPoolClock;
  baseCooldownMs?: number;
  maxCooldownMs?: number;
  stateTtlMs?: number;
  maxStateEntries?: number;
}

export type AuthSlotSelectionReason = "available" | "all_slots_cooled_fail_open";

export interface AuthSlotSelection {
  poolId: AuthPoolId;
  slotId: AuthSlotId;
  slot: AuthSlot;
  reason: AuthSlotSelectionReason;
  cooledDown: boolean;
  cooldownUntil?: string;
}

export interface AuthSlotSnapshotEntry {
  id: AuthSlotId;
  authRefHash: string;
  priority: number;
  enabled: boolean;
  inflight: number;
  consecutiveFailures: number;
  health: RouteHealthStatus;
  lastUsedAt?: string;
  cooldownUntil?: string;
  lastFailureClass?: FailureClass;
}

export interface AuthSlotPoolSnapshot {
  id: AuthPoolId;
  slots: AuthSlotSnapshotEntry[];
}

export interface SparkRouteRequiredCapabilities {
  input?: SparkModelInputModality[];
  reasoning?: boolean;
  toolUse?: boolean;
}

export interface SparkRouteResolverRequest {
  sparkModelId: SparkModelId;
  sessionId?: string;
  workflowRunId?: string;
  capabilities?: SparkRouteRequiredCapabilities;
  reasoning?: boolean;
  excludeRouteIds?: ProviderRouteId[];
  traceMaxEvents?: number;
}

export interface SparkRouteExecutionAttempt<TApi extends Api = Api> {
  decision: RouteDecision;
  model: Model<TApi>;
  trace: RouteTrace;
}

export interface SparkRouteExecutionResult<TResult> {
  result: TResult;
  decision: RouteDecision;
  trace: RouteTrace;
}

export type SparkRouteExecutor<TResult> = (
  attempt: SparkRouteExecutionAttempt,
) => TResult | Promise<TResult>;

export type SparkAssistantMessageEventStream = AsyncIterable<AssistantMessageEvent> & {
  result(): Promise<AssistantMessage>;
};

export class SparkModelValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid SparkModelProfile: ${issues.join("; ")}`);
    this.name = "SparkModelValidationError";
    this.issues = issues;
  }
}

export class SparkModelRegistry {
  readonly #profiles = new Map<SparkModelId, SparkModelProfile>();

  constructor(profiles: Iterable<SparkModelProfile> = []) {
    for (const profile of profiles) this.add(profile);
  }

  get size(): number {
    return this.#profiles.size;
  }

  add(profile: SparkModelProfile): SparkModelProfile {
    const valid = validateSparkModelProfile(profile);
    if (this.#profiles.has(valid.id)) {
      throw new SparkModelValidationError([`duplicate Spark model profile id: ${valid.id}`]);
    }
    this.#profiles.set(valid.id, valid);
    return valid;
  }

  addMany(profiles: Iterable<SparkModelProfile>): void {
    for (const profile of profiles) this.add(profile);
  }

  get(id: SparkModelId): SparkModelProfile | undefined {
    return this.#profiles.get(id);
  }

  require(id: SparkModelId): SparkModelProfile {
    const profile = this.get(id);
    if (!profile) throw new SparkModelValidationError([`unknown Spark model profile id: ${id}`]);
    return profile;
  }

  has(id: SparkModelId): boolean {
    return this.#profiles.has(id);
  }

  list(): SparkModelProfile[] {
    return [...this.#profiles.values()];
  }
}

export function createSparkModelRegistry(
  profiles: Iterable<SparkModelProfile> = [],
): SparkModelRegistry {
  return new SparkModelRegistry(profiles);
}

export function validateSparkModelProfile(profile: unknown): SparkModelProfile {
  const issues = collectSparkModelProfileIssues(profile);
  if (issues.length > 0) throw new SparkModelValidationError(issues);
  return profile as SparkModelProfile;
}

export function materializeRouteModel<TApi extends Api>(
  profile: SparkModelProfile,
  route: ProviderRoute<TApi>,
): Model<TApi> {
  const valid = validateSparkModelProfile(profile);
  if (!valid.routes.some((candidate) => candidate.id === route.id)) {
    throw new SparkModelValidationError([
      `route ${route.id} does not belong to Spark model profile: ${valid.id}`,
    ]);
  }

  return {
    id: route.transportModelId,
    name: route.label ? `${valid.name} (${route.label})` : valid.name,
    api: route.transportApi,
    provider: route.provider,
    baseUrl: route.baseUrl,
    reasoning: valid.capabilities.reasoning,
    input: [...valid.capabilities.input],
    cost: { ...valid.cost },
    contextWindow: valid.contextWindow,
    maxTokens: valid.maxTokens,
    ...(valid.thinkingLevelMap !== undefined ? { thinkingLevelMap: valid.thinkingLevelMap } : {}),
    ...(route.headers !== undefined ? { headers: route.headers } : {}),
    ...(route.compat !== undefined ? { compat: route.compat } : {}),
  };
}

export function resolveSparkModelMessageIdentity(
  profile: SparkModelProfile,
): ResolvedSparkModelIdentity {
  return {
    api: profile.identity?.api ?? "spark-ai",
    provider: profile.identity?.provider ?? "spark-ai",
    model: profile.identity?.model ?? profile.id,
  };
}

export function retagAssistantMessage(
  message: AssistantMessage,
  identity: ResolvedSparkModelIdentity,
): AssistantMessage {
  return { ...message, api: identity.api, provider: identity.provider, model: identity.model };
}

export function retagAssistantMessageEvent(
  event: AssistantMessageEvent,
  identity: ResolvedSparkModelIdentity,
): AssistantMessageEvent {
  if (event.type === "done")
    return { ...event, message: retagAssistantMessage(event.message, identity) };
  if (event.type === "error")
    return { ...event, error: retagAssistantMessage(event.error, identity) };
  return { ...event, partial: retagAssistantMessage(event.partial, identity) };
}

export function retagAssistantMessageStream(
  stream: SparkAssistantMessageEventStream,
  identity: ResolvedSparkModelIdentity,
): SparkAssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of stream) yield retagAssistantMessageEvent(event, identity);
    },
    async result() {
      return retagAssistantMessage(await stream.result(), identity);
    },
  };
}

export const FAILURE_CLASS_POLICIES: Readonly<Record<FailureClass, FailurePolicyHint>> = {
  auth: { retriable: false, cooldown: true, failover: true },
  rate_limit: { retriable: true, cooldown: true, failover: true },
  context_overflow: { retriable: false, cooldown: false, failover: false },
  provider_mismatch: { retriable: false, cooldown: false, failover: false },
  transient: { retriable: true, cooldown: true, failover: true },
  fatal: { retriable: false, cooldown: false, failover: false },
  aborted: { retriable: false, cooldown: false, failover: false },
};

export function classifyProviderFailure(input: unknown): ProviderFailureClassification {
  const normalized = normalizeProviderFailure(input);
  const failureClass = chooseFailureClass(normalized);
  return {
    failureClass,
    policy: FAILURE_CLASS_POLICIES[failureClass],
    message: normalized.message,
    ...(normalized.status !== undefined ? { status: normalized.status } : {}),
  };
}

interface AuthSlotRuntimeState {
  inflight: number;
  consecutiveFailures: number;
  cooldownUntilMs?: number;
  lastUsedAtMs?: number;
  lastTouchedAtMs?: number;
  lastFailureClass?: FailureClass;
}

export class SparkAuthSlotPool {
  readonly #pool: SparkAuthPool;
  readonly #clock: SparkAuthSlotPoolClock;
  readonly #baseCooldownMs: number;
  readonly #maxCooldownMs: number;
  readonly #stateTtlMs: number;
  readonly #maxStateEntries: number;
  readonly #states = new Map<AuthSlotId, AuthSlotRuntimeState>();

  constructor(pool: SparkAuthPool, options: SparkAuthSlotPoolOptions = {}) {
    if (!pool.slots.length)
      throw new SparkModelValidationError([`auth pool ${pool.id} has no slots`]);
    this.#pool = pool;
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#baseCooldownMs = options.baseCooldownMs ?? 30_000;
    this.#maxCooldownMs = options.maxCooldownMs ?? 5 * 60_000;
    this.#stateTtlMs = options.stateTtlMs ?? 30 * 60_000;
    this.#maxStateEntries = options.maxStateEntries ?? 256;
  }

  selectSlot(): AuthSlotSelection {
    this.#pruneState();
    const enabled = this.#pool.slots.filter((slot) => slot.enabled !== false);
    if (!enabled.length)
      throw new SparkModelValidationError([`auth pool ${this.#pool.id} has no enabled slots`]);

    const now = this.#clock.now();
    const available = enabled.filter((slot) => !this.#isCooling(slot.id, now));
    const picked = available.length
      ? this.#bestAvailableSlot(available)
      : this.#leastCooledSlot(enabled, now);
    const state = this.#stateFor(picked.slot.id, now);
    state.inflight += 1;
    state.lastUsedAtMs = now;
    state.lastTouchedAtMs = now;

    return {
      poolId: this.#pool.id,
      slotId: picked.slot.id,
      slot: picked.slot,
      reason: available.length ? "available" : "all_slots_cooled_fail_open",
      cooledDown: !available.length,
      ...(picked.cooldownUntilMs !== undefined
        ? { cooldownUntil: new Date(picked.cooldownUntilMs).toISOString() }
        : {}),
    };
  }

  recordSuccess(slotId: AuthSlotId): void {
    const now = this.#clock.now();
    const state = this.#stateFor(slotId, now);
    state.inflight = Math.max(0, state.inflight - 1);
    state.consecutiveFailures = 0;
    delete state.cooldownUntilMs;
    delete state.lastFailureClass;
    state.lastTouchedAtMs = now;
  }

  recordFailure(slotId: AuthSlotId, failure: unknown): void {
    const now = this.#clock.now();
    const failureClass = normalizeFailureClass(failure);
    const policy = FAILURE_CLASS_POLICIES[failureClass];
    const state = this.#stateFor(slotId, now);
    state.inflight = Math.max(0, state.inflight - 1);
    state.consecutiveFailures += 1;
    state.lastFailureClass = failureClass;
    state.lastTouchedAtMs = now;
    if (policy.cooldown) {
      state.cooldownUntilMs = now + this.#cooldownMs(state.consecutiveFailures);
    }
  }

  snapshot(): AuthSlotPoolSnapshot {
    const now = this.#clock.now();
    this.#pruneState();
    return {
      id: this.#pool.id,
      slots: this.#pool.slots.map((slot) => {
        const state = this.#states.get(slot.id);
        const cooldownUntilMs = state?.cooldownUntilMs;
        return {
          id: slot.id,
          authRefHash: authRefHash(slot.authRef),
          priority: slot.priority,
          enabled: slot.enabled !== false,
          inflight: state?.inflight ?? 0,
          consecutiveFailures: state?.consecutiveFailures ?? 0,
          health: this.#slotHealth(slot, state, now),
          ...(state?.lastUsedAtMs !== undefined
            ? { lastUsedAt: new Date(state.lastUsedAtMs).toISOString() }
            : {}),
          ...(cooldownUntilMs !== undefined
            ? { cooldownUntil: new Date(cooldownUntilMs).toISOString() }
            : {}),
          ...(state?.lastFailureClass !== undefined
            ? { lastFailureClass: state.lastFailureClass }
            : {}),
        };
      }),
    };
  }

  #bestAvailableSlot(slots: AuthSlot[]): { slot: AuthSlot; cooldownUntilMs?: number } {
    return { slot: [...slots].sort(compareAuthSlots(this.#states))[0]! };
  }

  #leastCooledSlot(slots: AuthSlot[], now: number): { slot: AuthSlot; cooldownUntilMs?: number } {
    return [...slots]
      .map((slot): { slot: AuthSlot; cooldownUntilMs?: number } => {
        const cooldownUntilMs = this.#states.get(slot.id)?.cooldownUntilMs;
        return cooldownUntilMs !== undefined ? { slot, cooldownUntilMs } : { slot };
      })
      .sort((left, right) => {
        const leftUntil = left.cooldownUntilMs ?? now;
        const rightUntil = right.cooldownUntilMs ?? now;
        if (leftUntil !== rightUntil) return leftUntil - rightUntil;
        return compareAuthSlots(this.#states)(left.slot, right.slot);
      })[0]!;
  }

  #isCooling(slotId: AuthSlotId, now: number): boolean {
    const cooldownUntil = this.#states.get(slotId)?.cooldownUntilMs;
    return cooldownUntil !== undefined && cooldownUntil > now;
  }

  #stateFor(slotId: AuthSlotId, now: number): AuthSlotRuntimeState {
    let state = this.#states.get(slotId);
    if (!state) {
      state = { inflight: 0, consecutiveFailures: 0, lastTouchedAtMs: now };
      this.#states.set(slotId, state);
    }
    return state;
  }

  #cooldownMs(consecutiveFailures: number): number {
    const exponent = Math.max(0, consecutiveFailures - 1);
    return Math.min(this.#baseCooldownMs * 2 ** exponent, this.#maxCooldownMs);
  }

  #slotHealth(
    slot: AuthSlot,
    state: AuthSlotRuntimeState | undefined,
    now: number,
  ): RouteHealthStatus {
    if (slot.enabled === false) return "disabled";
    if (state?.cooldownUntilMs !== undefined && state.cooldownUntilMs > now) return "cooldown";
    if (state?.lastFailureClass === "auth") return "stale_auth";
    if (state?.lastFailureClass === "transient") return "degraded";
    return "ok";
  }

  #pruneState(): void {
    const now = this.#clock.now();
    const slotIds = new Set(this.#pool.slots.map((slot) => slot.id));
    for (const [slotId, state] of this.#states) {
      if (!slotIds.has(slotId)) {
        this.#states.delete(slotId);
        continue;
      }
      const lastTouchedAt = state.lastTouchedAtMs ?? state.lastUsedAtMs ?? now;
      if (now - lastTouchedAt > this.#stateTtlMs && state.inflight <= 0)
        this.#states.delete(slotId);
    }
    while (this.#states.size > this.#maxStateEntries) {
      const oldest = [...this.#states.entries()].sort(
        (left, right) =>
          (left[1].lastTouchedAtMs ?? left[1].lastUsedAtMs ?? now) -
          (right[1].lastTouchedAtMs ?? right[1].lastUsedAtMs ?? now),
      )[0]?.[0];
      if (!oldest) break;
      this.#states.delete(oldest);
    }
  }
}

export class SparkRouteResolutionError extends Error {
  readonly trace: RouteTrace;

  constructor(message: string, trace: RouteTrace) {
    super(message);
    this.name = "SparkRouteResolutionError";
    this.trace = trace;
  }
}

export class SparkRouteExecutionError extends Error {
  readonly classification: ProviderFailureClassification;
  readonly trace: RouteTrace;

  constructor(message: string, classification: ProviderFailureClassification, trace: RouteTrace) {
    super(message);
    this.name = "SparkRouteExecutionError";
    this.classification = classification;
    this.trace = trace;
  }
}

export class SparkRouteResolver {
  readonly #registry: SparkModelRegistry;
  readonly #clock: SparkAuthSlotPoolClock;
  readonly #traceMaxEvents: number;
  readonly #sticky = new Map<string, ProviderRouteId>();
  readonly #authPools = new Map<string, SparkAuthSlotPool>();

  constructor(
    registry: SparkModelRegistry,
    options: { clock?: SparkAuthSlotPoolClock; traceMaxEvents?: number } = {},
  ) {
    this.#registry = registry;
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#traceMaxEvents = options.traceMaxEvents ?? 32;
  }

  resolve(request: SparkRouteResolverRequest): RouteDecision {
    const trace = new RouteTraceBuilder(
      request.traceMaxEvents ?? this.#traceMaxEvents,
      this.#clock,
    );
    return this.#resolveInternal(request, new Set(request.excludeRouteIds ?? []), trace);
  }

  async executeWithFailover<TResult>(
    request: SparkRouteResolverRequest,
    executor: SparkRouteExecutor<TResult>,
  ): Promise<SparkRouteExecutionResult<TResult>> {
    return this.#execute(request, executor, { failover: true });
  }

  /**
   * Execute exactly one route attempt with full auth-slot/route accounting but
   * no failover: a failure is recorded against the selected auth slot (with its
   * real failure class) and then surfaced as a SparkRouteExecutionError instead
   * of advancing to another route. Callers that want single-shot semantics
   * (e.g. Spark leaf capabilities) use this so a failed call still degrades
   * shared route/auth-slot health correctly rather than being logged as a
   * success or silently retried on another route.
   */
  async executeOnce<TResult>(
    request: SparkRouteResolverRequest,
    executor: SparkRouteExecutor<TResult>,
  ): Promise<SparkRouteExecutionResult<TResult>> {
    return this.#execute(request, executor, { failover: false });
  }

  async #execute<TResult>(
    request: SparkRouteResolverRequest,
    executor: SparkRouteExecutor<TResult>,
    options: { failover: boolean },
  ): Promise<SparkRouteExecutionResult<TResult>> {
    const trace = new RouteTraceBuilder(
      request.traceMaxEvents ?? this.#traceMaxEvents,
      this.#clock,
    );
    const excluded = new Set(request.excludeRouteIds ?? []);
    let lastClassification: ProviderFailureClassification | undefined;

    for (;;) {
      const decision = this.#resolveInternal(request, excluded, trace);
      try {
        const model = materializeRouteModel(
          this.#registry.require(request.sparkModelId),
          decision.route,
        );
        const result = await executor({ decision, model, trace: trace.snapshot() });
        const authSlotId = requireDecisionAuthSlot(decision);
        this.#authPoolFor(
          this.#registry.require(request.sparkModelId),
          decision.authPoolId,
        ).recordSuccess(authSlotId);
        this.#setSticky(request, decision.routeId);
        trace.add("REQUEST_FINAL", request.sparkModelId, {
          routeId: decision.routeId,
          authPoolId: decision.authPoolId,
          authSlotId,
          reason: "ok",
        });
        return {
          result,
          decision: { ...decision, trace: trace.snapshot() },
          trace: trace.snapshot(),
        };
      } catch (error) {
        const classification = classifyProviderFailure(error);
        lastClassification = classification;
        const authSlotId = requireDecisionAuthSlot(decision);
        this.#authPoolFor(
          this.#registry.require(request.sparkModelId),
          decision.authPoolId,
        ).recordFailure(authSlotId, classification);
        trace.add("REQUEST_FINAL", request.sparkModelId, {
          routeId: decision.routeId,
          authPoolId: decision.authPoolId,
          authSlotId,
          reason: classification.failureClass,
        });
        this.#clearSticky(request, decision.routeId);
        if (!options.failover || !classification.policy.failover) {
          throw new SparkRouteExecutionError(
            `Spark route ${decision.routeId} failed with ${classification.failureClass}: ${classification.message}`,
            classification,
            trace.snapshot(),
          );
        }
        excluded.add(decision.routeId);
      }
    }

    throw new SparkRouteExecutionError(
      "Spark route execution failed without an available failover route.",
      lastClassification ?? classifyProviderFailure("unknown provider failure"),
      trace.snapshot(),
    );
  }

  #resolveInternal(
    request: SparkRouteResolverRequest,
    excluded: ReadonlySet<ProviderRouteId>,
    trace: RouteTraceBuilder,
  ): RouteDecision {
    const profile = this.#registry.require(request.sparkModelId);
    const candidates = [...profile.routes]
      .filter((route) => route.enabled !== false)
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
    trace.add("CANDIDATE_POOL", profile.id, {
      reason: `candidates:${candidates.length}`,
      details: { routeIds: candidates.map((route) => route.id) },
    });

    const stickyRouteId = this.#stickyKey(request)
      ? this.#sticky.get(this.#stickyKey(request)!)
      : undefined;
    const ordered = stickyRouteId
      ? [
          ...candidates.filter((route) => route.id === stickyRouteId),
          ...candidates.filter((route) => route.id !== stickyRouteId),
        ]
      : candidates;

    for (const route of ordered) {
      if (excluded.has(route.id)) {
        trace.add("CANDIDATE_SKIP", profile.id, { routeId: route.id, reason: "excluded" });
        continue;
      }
      const capabilitySkip = capabilitySkipReason(profile, request);
      if (capabilitySkip) {
        trace.add("CANDIDATE_SKIP", profile.id, { routeId: route.id, reason: capabilitySkip });
        continue;
      }
      let selection: AuthSlotSelection;
      try {
        selection = this.#authPoolFor(profile, route.authPoolId).selectSlot();
      } catch (error) {
        trace.add("CANDIDATE_SKIP", profile.id, {
          routeId: route.id,
          authPoolId: route.authPoolId,
          reason: error instanceof Error ? error.message : "auth pool unavailable",
        });
        continue;
      }
      const reason: RouteDecisionReason =
        route.id === stickyRouteId ? "sticky_available" : "ordered_available";
      trace.add("CANDIDATE_START", profile.id, {
        routeId: route.id,
        authPoolId: route.authPoolId,
        authSlotId: selection.slotId,
        reason,
      });
      const decision: RouteDecision = {
        profileId: profile.id,
        routeId: route.id,
        authPoolId: route.authPoolId,
        authSlotId: selection.slotId,
        reason,
        route,
        authSlot: selection.slot,
        sticky: route.id === stickyRouteId,
        trace: trace.snapshot(),
      };
      this.#setSticky(request, route.id);
      return decision;
    }

    throw new SparkRouteResolutionError(
      `No available route for Spark model ${profile.id}`,
      trace.snapshot(),
    );
  }

  #authPoolFor(profile: SparkModelProfile, authPoolId: AuthPoolId): SparkAuthSlotPool {
    const key = `${profile.id}:${authPoolId}`;
    const cached = this.#authPools.get(key);
    if (cached) return cached;
    const pool = profile.authPools?.find((candidate) => candidate.id === authPoolId);
    if (!pool) throw new SparkModelValidationError([`unknown auth pool for route: ${authPoolId}`]);
    const created = new SparkAuthSlotPool(pool, { clock: this.#clock });
    this.#authPools.set(key, created);
    return created;
  }

  /** Snapshot the auth-slot pools this resolver has touched, for health inspection/tests. */
  authPoolSnapshots(): AuthSlotPoolSnapshot[] {
    return [...this.#authPools.values()].map((pool) => pool.snapshot());
  }

  #stickyKey(request: SparkRouteResolverRequest): string | undefined {
    const id = request.workflowRunId ?? request.sessionId;
    return id ? `${request.sparkModelId}:${id}` : undefined;
  }

  #setSticky(request: SparkRouteResolverRequest, routeId: ProviderRouteId): void {
    const key = this.#stickyKey(request);
    if (key) this.#sticky.set(key, routeId);
  }

  #clearSticky(request: SparkRouteResolverRequest, routeId: ProviderRouteId): void {
    const key = this.#stickyKey(request);
    if (key && this.#sticky.get(key) === routeId) this.#sticky.delete(key);
  }
}

function requireDecisionAuthSlot(decision: RouteDecision): AuthSlotId {
  if (!decision.authSlotId) {
    throw new SparkRouteResolutionError(
      `Route ${decision.routeId} did not resolve an auth slot`,
      decision.trace,
    );
  }
  return decision.authSlotId;
}

class RouteTraceBuilder {
  readonly #events: RouteTraceEvent[] = [];
  readonly maxEvents: number;
  readonly clock: SparkAuthSlotPoolClock;

  constructor(maxEvents: number, clock: SparkAuthSlotPoolClock) {
    this.maxEvents = maxEvents;
    this.clock = clock;
  }

  add(
    type: RouteTraceEventType,
    profileId: SparkModelId,
    options: {
      routeId?: ProviderRouteId;
      authPoolId?: AuthPoolId;
      authSlotId?: AuthSlotId;
      reason?: string;
      details?: Record<string, unknown>;
    } = {},
  ): void {
    this.#events.push({
      type,
      at: new Date(this.clock.now()).toISOString(),
      profileId,
      ...options,
    });
    while (this.#events.length > this.maxEvents) this.#events.shift();
  }

  snapshot(): RouteTrace {
    return { events: [...this.#events], maxEvents: this.maxEvents };
  }
}

function capabilitySkipReason(
  profile: SparkModelProfile,
  request: SparkRouteResolverRequest,
): string | undefined {
  const inputs = request.capabilities?.input ?? [];
  for (const input of inputs) {
    if (!profile.capabilities.input.includes(input)) return `capability_mismatch:input:${input}`;
  }
  if (
    (request.reasoning === true || request.capabilities?.reasoning === true) &&
    !profile.capabilities.reasoning
  ) {
    return "capability_mismatch:reasoning";
  }
  if (request.capabilities?.toolUse === true && profile.capabilities.toolUse !== true) {
    return "capability_mismatch:toolUse";
  }
  return undefined;
}

function normalizeFailureClass(failure: unknown): FailureClass {
  if (typeof failure === "string" && failure in FAILURE_CLASS_POLICIES)
    return failure as FailureClass;
  if (isRecord(failure) && typeof failure.failureClass === "string") {
    const failureClass = failure.failureClass;
    if (failureClass in FAILURE_CLASS_POLICIES) return failureClass as FailureClass;
  }
  return classifyProviderFailure(failure).failureClass;
}

function compareAuthSlots(states: ReadonlyMap<AuthSlotId, AuthSlotRuntimeState>) {
  return (left: AuthSlot, right: AuthSlot): number => {
    if (left.priority !== right.priority) return right.priority - left.priority;
    const leftInflight = states.get(left.id)?.inflight ?? 0;
    const rightInflight = states.get(right.id)?.inflight ?? 0;
    if (leftInflight !== rightInflight) return leftInflight - rightInflight;
    const leftUsedAt = states.get(left.id)?.lastUsedAtMs ?? 0;
    const rightUsedAt = states.get(right.id)?.lastUsedAtMs ?? 0;
    if (leftUsedAt !== rightUsedAt) return leftUsedAt - rightUsedAt;
    return left.id.localeCompare(right.id);
  };
}

function authRefHash(authRef: SparkAuthRef): string {
  const encoded =
    authRef.kind === "env"
      ? `env:${authRef.name}`
      : authRef.kind === "secret"
        ? `secret:${authRef.id}`
        : `provider:${authRef.id}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < encoded.length; index += 1) {
    hash ^= encoded.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function chooseFailureClass(input: NormalizedProviderFailure): FailureClass {
  const text = input.message.toLowerCase();
  if (input.stopReason === "aborted") return "aborted";
  if (/mismatched api:/u.test(text)) return "provider_mismatch";
  if (
    /context[_ -]?(window|length|overflow)|maximum context|prompt is too long|too many tokens/u.test(
      text,
    )
  ) {
    return "context_overflow";
  }
  if (input.status === 401 || input.status === 403) return "auth";
  if (
    /no api key|invalid api key|unauthori[sz]ed|forbidden|authentication|permission denied/u.test(
      text,
    )
  ) {
    return "auth";
  }
  if (input.status === 429) return "rate_limit";
  if (/rate limit|too many requests|quota exceeded|insufficient quota/u.test(text))
    return "rate_limit";
  if (input.status && (input.status === 408 || input.status === 409 || input.status >= 500)) {
    return "transient";
  }
  if (
    /econnreset|etimedout|timeout|socket hang up|temporary|temporarily|network error/u.test(text)
  ) {
    return "transient";
  }
  return "fatal";
}

interface NormalizedProviderFailure {
  message: string;
  status?: number;
  stopReason?: string;
}

function normalizeProviderFailure(input: unknown): NormalizedProviderFailure {
  const candidates = collectFailureCandidates(input);
  const message =
    candidates.messages.find((candidate) => candidate.trim())?.trim() || "unknown provider failure";
  return {
    message,
    ...(candidates.status !== undefined ? { status: candidates.status } : {}),
    ...(candidates.stopReason !== undefined ? { stopReason: candidates.stopReason } : {}),
  };
}

function collectFailureCandidates(input: unknown): {
  messages: string[];
  status?: number;
  stopReason?: string;
} {
  const messages: string[] = [];
  let status: number | undefined;
  let stopReason: string | undefined;

  function visit(value: unknown): void {
    if (value === undefined || value === null) return;
    if (typeof value === "string") {
      messages.push(value);
      return;
    }
    if (value instanceof Error) {
      messages.push(value.message);
      status ??= extractStatus(value);
      if (value.cause) visit(value.cause);
      return;
    }
    if (!isRecord(value)) {
      messages.push(primitiveFailureMessage(value));
      return;
    }

    status ??= extractStatus(value);
    const maybeStopReason = value.stopReason;
    if (typeof maybeStopReason === "string") stopReason ??= maybeStopReason;
    const maybeErrorMessage = value.errorMessage;
    if (typeof maybeErrorMessage === "string") messages.push(maybeErrorMessage);
    const maybeMessage = value.message;
    if (typeof maybeMessage === "string") messages.push(maybeMessage);
    else if (maybeMessage !== undefined) visit(maybeMessage);
    if (value.assistantMessage !== undefined) visit(value.assistantMessage);
    if (value.error !== undefined) visit(value.error);
    if (value.cause !== undefined) visit(value.cause);
    if (value.response !== undefined) visit(value.response);
  }

  visit(input);
  return {
    messages,
    ...(status !== undefined ? { status } : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
  };
}

function primitiveFailureMessage(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "symbol") return value.description ?? "symbol provider failure";
  if (typeof value === "function") return value.name || "function provider failure";
  if (typeof value === "object") return JSON.stringify(value) ?? "object provider failure";
  return "unknown provider failure";
}

function extractStatus(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ["status", "statusCode", "code"]) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isInteger(candidate)) return candidate;
    if (typeof candidate === "string" && /^\d{3}$/u.test(candidate)) return Number(candidate);
  }
  const response = value.response;
  if (isRecord(response)) return extractStatus(response);
  return undefined;
}

export function collectSparkModelProfileIssues(profile: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(profile)) return ["profile must be an object"];

  requireNonEmptyString(profile, "id", "profile.id", issues);
  requireNonEmptyString(profile, "name", "profile.name", issues);
  validateCapabilities(profile.capabilities, issues);
  validateCost(profile.cost, issues);
  requireNonNegativeNumber(profile, "contextWindow", "profile.contextWindow", issues);
  requireNonNegativeNumber(profile, "maxTokens", "profile.maxTokens", issues);
  validateIdentity(profile.identity, issues);
  validateRoutes(profile.routes, profile.authPools, issues);
  validateAuthPools(profile.authPools, issues);

  return issues;
}

function validateIdentity(identity: unknown, issues: string[]): void {
  if (identity === undefined) return;
  if (!isRecord(identity)) {
    issues.push("profile.identity must be an object when present");
    return;
  }
  if (identity.api !== undefined)
    requireNonEmptyString(identity, "api", "profile.identity.api", issues);
  if (identity.provider !== undefined) {
    requireNonEmptyString(identity, "provider", "profile.identity.provider", issues);
  }
  if (identity.model !== undefined) {
    requireNonEmptyString(identity, "model", "profile.identity.model", issues);
  }
}

function validateCapabilities(value: unknown, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push("profile.capabilities must be an object");
    return;
  }
  if (!Array.isArray(value.input) || value.input.length === 0) {
    issues.push("profile.capabilities.input must be a non-empty array");
  } else {
    for (const [index, input] of value.input.entries()) {
      if (input !== "text" && input !== "image") {
        issues.push(`profile.capabilities.input[${index}] must be text or image`);
      }
    }
  }
  if (typeof value.reasoning !== "boolean") {
    issues.push("profile.capabilities.reasoning must be a boolean");
  }
  if (value.toolUse !== undefined && typeof value.toolUse !== "boolean") {
    issues.push("profile.capabilities.toolUse must be a boolean when present");
  }
}

function validateCost(value: unknown, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push("profile.cost must be an object");
    return;
  }
  requireNonNegativeNumber(value, "input", "profile.cost.input", issues);
  requireNonNegativeNumber(value, "output", "profile.cost.output", issues);
  requireNonNegativeNumber(value, "cacheRead", "profile.cost.cacheRead", issues);
  requireNonNegativeNumber(value, "cacheWrite", "profile.cost.cacheWrite", issues);
}

function validateRoutes(routes: unknown, authPools: unknown, issues: string[]): void {
  if (!Array.isArray(routes) || routes.length === 0) {
    issues.push("profile.routes must be a non-empty array");
    return;
  }
  const routeIds = new Set<string>();
  const authPoolIds = new Set<string>();
  if (Array.isArray(authPools)) {
    for (const pool of authPools) {
      if (isRecord(pool) && typeof pool.id === "string" && pool.id.trim()) {
        authPoolIds.add(pool.id.trim());
      }
    }
  }

  for (const [index, route] of routes.entries()) {
    const path = `profile.routes[${index}]`;
    if (!isRecord(route)) {
      issues.push(`${path} must be an object`);
      continue;
    }
    const id = requireNonEmptyString(route, "id", `${path}.id`, issues);
    if (id) {
      if (routeIds.has(id)) issues.push(`duplicate route id in profile.routes: ${id}`);
      routeIds.add(id);
    }
    requireNonEmptyString(route, "provider", `${path}.provider`, issues);
    requireNonEmptyString(route, "transportApi", `${path}.transportApi`, issues);
    requireNonEmptyString(route, "transportModelId", `${path}.transportModelId`, issues);
    requireNonEmptyString(route, "baseUrl", `${path}.baseUrl`, issues);
    const authPoolId = requireNonEmptyString(route, "authPoolId", `${path}.authPoolId`, issues);
    if (authPoolId && !authPoolIds.has(authPoolId)) {
      issues.push(`${path}.authPoolId references unknown auth pool: ${authPoolId}`);
    }
    requireFiniteNumber(route, "priority", `${path}.priority`, issues);
    if (route.enabled !== undefined && typeof route.enabled !== "boolean") {
      issues.push(`${path}.enabled must be a boolean when present`);
    }
    if (route.headers !== undefined && !isStringRecord(route.headers)) {
      issues.push(`${path}.headers must be a record of strings when present`);
    }
  }
}

function validateAuthPools(authPools: unknown, issues: string[]): void {
  if (authPools === undefined) return;
  if (!Array.isArray(authPools)) {
    issues.push("profile.authPools must be an array when present");
    return;
  }
  const poolIds = new Set<string>();
  for (const [poolIndex, pool] of authPools.entries()) {
    const poolPath = `profile.authPools[${poolIndex}]`;
    if (!isRecord(pool)) {
      issues.push(`${poolPath} must be an object`);
      continue;
    }
    const poolId = requireNonEmptyString(pool, "id", `${poolPath}.id`, issues);
    if (poolId) {
      if (poolIds.has(poolId))
        issues.push(`duplicate auth pool id in profile.authPools: ${poolId}`);
      poolIds.add(poolId);
    }
    if (!Array.isArray(pool.slots) || pool.slots.length === 0) {
      issues.push(`${poolPath}.slots must be a non-empty array`);
      continue;
    }
    const slotIds = new Set<string>();
    for (const [slotIndex, slot] of pool.slots.entries()) {
      const slotPath = `${poolPath}.slots[${slotIndex}]`;
      if (!isRecord(slot)) {
        issues.push(`${slotPath} must be an object`);
        continue;
      }
      const slotId = requireNonEmptyString(slot, "id", `${slotPath}.id`, issues);
      if (slotId) {
        if (slotIds.has(slotId))
          issues.push(`duplicate auth slot id in ${poolPath}.slots: ${slotId}`);
        slotIds.add(slotId);
      }
      requireFiniteNumber(slot, "priority", `${slotPath}.priority`, issues);
      validateAuthRef(slot.authRef, `${slotPath}.authRef`, issues);
      if (slot.enabled !== undefined && typeof slot.enabled !== "boolean") {
        issues.push(`${slotPath}.enabled must be a boolean when present`);
      }
    }
  }
}

function validateAuthRef(authRef: unknown, path: string, issues: string[]): void {
  if (!isRecord(authRef)) {
    issues.push(`${path} must be an object`);
    return;
  }
  if (authRef.kind === "env") {
    requireNonEmptyString(authRef, "name", `${path}.name`, issues);
    return;
  }
  if (authRef.kind === "secret" || authRef.kind === "provider") {
    requireNonEmptyString(authRef, "id", `${path}.id`, issues);
    return;
  }
  issues.push(`${path}.kind must be env, secret, or provider`);
}

function requireNonEmptyString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[],
): string | undefined {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    issues.push(`${path} must be a non-empty string`);
    return undefined;
  }
  return value.trim();
}

function requireNonNegativeNumber(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[],
): number | undefined {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    issues.push(`${path} must be a non-negative finite number`);
    return undefined;
  }
  return value;
}

function requireFiniteNumber(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[],
): number | undefined {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push(`${path} must be a finite number`);
    return undefined;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

export {
  SparkProviderRegistry,
  type ProviderConfig,
  type ProviderModelDefinition,
  type ProviderRegistrationAPI,
  type SparkActiveSelection,
} from "./provider-registry.ts";
export {
  assistantMessageToText,
  createProviderRegistryStreamFunction,
  createProviderRegistryWorkflowModelRunner,
  normalizeProviderStream,
  openAiCompatiblePromptCachePayload,
  resolveWorkflowModelSelection,
  withOpenAiCompatiblePromptCacheKey,
  type ProviderRegistryRunnerOptions,
  type SparkProviderStreamFunction,
  type SparkWorkflowModelRunRequest,
  type SparkWorkflowModelRunResponse,
} from "./provider-runner.ts";
export {
  default as sparkModelsExtension,
  registerSparkModelsTool,
  type SparkModelsExtensionApi,
} from "./models-extension.ts";
export {
  default as registerBaiduOneApiProvider,
  remapBaiduOneApiPayload,
  resolveBaiduOneApiKey,
  streamBaiduOneApi,
  streamBaiduOneApiAnthropic,
  streamBaiduOneApiOpenAIResponses,
} from "./baidu-oneapi-provider.ts";
export {
  OPENAI_CODEX_API,
  OPENAI_CODEX_BASE_URL,
  OPENAI_CODEX_PROVIDER_ID,
  default as registerOpenAICodexProvider,
} from "./openai-codex-provider.ts";
export { piAiProviderConfig, registerPiAiProvider } from "./pi-provider-adapter.ts";
export type { PiProviderAdapterOptions } from "./pi-provider-adapter.ts";
export {
  CURSOR_API_KEY_ENV,
  CURSOR_PROVIDER_API,
  CURSOR_PROVIDER_BASE_URL,
  CURSOR_PROVIDER_ID,
  default as registerCursorProvider,
  type RegisterCursorProviderOptions,
} from "./cursor-provider.ts";
export {
  buildCursorPrompt,
  createCursorStreamFunction,
  streamCursor,
  type CursorSdkRuntime,
  type CursorStreamDependencies,
} from "./cursor-stream.ts";
export {
  buildCursorModelSelection,
  convertCursorModelItems,
  getCursorModelMetadata,
  getCursorModelMetadataEntries,
  type CursorModelMetadata,
} from "./cursor-model-catalog.ts";
export {
  discoverCursorModels,
  sanitizeCursorDiscoveryError,
  type CursorCatalogFallbackIssue,
  type CursorCatalogFallbackReason,
  type DiscoverCursorModelsOptions,
} from "./cursor-model-discovery.ts";
export {
  DEFAULT_CURSOR_MODEL_CACHE_TTL_MS,
  defaultCursorModelCachePath,
  fingerprintCursorApiKey,
  loadCursorModelCache,
  saveCursorModelCache,
} from "./cursor-model-cache.ts";
export {
  runSparkLeaf,
  resolveLeafModelId,
  type SparkLeafRequest,
  type SparkLeafResult,
  type SparkLeafDegradeReason,
  type SparkLeafModelBinding,
  type SparkLeafBindingResolver,
  type SparkLeafRunnerDeps,
} from "./leaf-runner.ts";
export {
  createProviderRegistryLeafRunner,
  type SparkLeafHostRunnerOptions,
} from "./leaf-host-runner.ts";
