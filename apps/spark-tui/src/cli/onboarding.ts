import type { SparkCliHostServices } from "../host/index.ts";

export interface SparkFirstRunOnboardingStatus {
  required: boolean;
  reason: "no-providers" | "no-active-model" | "missing-active-auth" | "ready";
  activeModel?: string;
  activeProvider?: string;
  authSummary?: string;
  providers: string[];
}

export function sparkFirstRunOnboardingStatus(
  services: SparkCliHostServices,
): SparkFirstRunOnboardingStatus {
  const registry = services.providerRegistry as SparkCliHostServices["providerRegistry"] & {
    getActive?: SparkCliHostServices["providerRegistry"]["getActive"];
    getProvider?: SparkCliHostServices["providerRegistry"]["getProvider"];
  };
  const providers = registry.listProviders();
  if (typeof registry.getActive !== "function") {
    return {
      required: false,
      reason: "ready",
      providers: providers.map((provider) => provider.name),
    };
  }
  const active = registry.getActive();
  if (providers.length === 0) {
    return { required: true, reason: "no-providers", providers: [] };
  }
  if (!active) {
    return {
      required: true,
      reason: "no-active-model",
      providers: providers.map((provider) => provider.name),
    };
  }

  const activeProvider = registry.getProvider?.(active.providerName);
  const authStatus = activeProvider ? services.authResolver?.status(activeProvider) : undefined;
  const activeModel = `${active.providerName}/${active.modelId}`;
  if (authStatus && !authStatus.configured) {
    return {
      required: true,
      reason: "missing-active-auth",
      activeModel,
      activeProvider: active.providerName,
      authSummary: `${authStatus.kind}${authStatus.ref ? `:${authStatus.ref}` : ""}`,
      providers: providers.map((provider) => provider.name),
    };
  }

  return {
    required: false,
    reason: "ready",
    activeModel,
    activeProvider: active.providerName,
    authSummary: authStatus
      ? `${authStatus.kind}${authStatus.ref ? `:${authStatus.ref}` : ""}`
      : undefined,
    providers: providers.map((provider) => provider.name),
  };
}

export function renderSparkFirstRunOnboarding(services: SparkCliHostServices): string | undefined {
  const status = sparkFirstRunOnboardingStatus(services);
  if (!status.required) return undefined;

  const providerLine =
    status.providers.length > 0
      ? `Registered providers: ${status.providers.join(", ")}`
      : "No providers are registered yet; install or configure a provider first.";
  const authLine =
    status.reason === "missing-active-auth" && status.activeProvider
      ? `Missing credentials for ${status.activeProvider}${status.authSummary ? ` (${status.authSummary})` : ""}.`
      : "Choose a provider/model before the first run.";

  return [
    "Spark first-run setup",
    authLine,
    providerLine,
    "1. Select a default model with /model [provider/model].",
    "2. Add credentials with /login api-key <provider> <key> or /login <oauth-provider>.",
    "3. Optional: start the daemon with /start, then send your first prompt.",
    "Run /login with no arguments to inspect auth status; secrets are stored in the effective Spark auth.json.",
  ].join("\n");
}
