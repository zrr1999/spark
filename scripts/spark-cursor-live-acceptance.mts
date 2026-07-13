import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SparkAuthStore } from "../apps/spark-tui/src/host/auth.ts";
import {
  SparkProviderRegistry,
  assistantMessageToText,
  createProviderRegistryStreamFunction,
  registerCursorProvider,
  type CursorCatalogFallbackIssue,
} from "../packages/spark-ai/src/index.ts";

const ACCEPTANCE_TOKEN = "SPARK_CURSOR_LIVE_OK";
const FORBIDDEN_OUTPUT_FIELD = /authorization|bearer|cookie|apiKey|sessionCredential/iu;

if (process.env.SPARK_CURSOR_LIVE_TEST !== "1") {
  throw new Error(
    "Live Cursor acceptance is opt-in; set SPARK_CURSOR_LIVE_TEST=1 while keeping the API key in existing environment or Spark auth.",
  );
}

const apiKey = await resolveExistingCursorApiKey();
if (!apiKey) {
  throw new Error(
    "Cursor live acceptance requires CURSOR_API_KEY or a Spark-stored API key for provider cursor.",
  );
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "spark-cursor-live-acceptance-"));
try {
  const registry = new SparkProviderRegistry();
  let fallbackIssue: CursorCatalogFallbackIssue | undefined;
  await registerCursorProvider(registry, {
    apiKey,
    cachePath: join(temporaryDirectory, "models.json"),
    forceRefresh: true,
    onCatalogFallback: (issue) => (fallbackIssue = issue),
  });
  if (fallbackIssue) {
    throw new Error(
      `Cursor live catalog was not used (${fallbackIssue.reason}): ${fallbackIssue.message}`,
    );
  }

  const models = registry.listModelsFor("cursor");
  if (models.length === 0) throw new Error("Cursor live catalog returned no selectable models.");
  const selected =
    models.find((model) => model.id === "composer-2.5") ??
    models.find((model) => model.id === "composer-2.5:slow") ??
    models.find((model) => model.id.startsWith("composer-2.5")) ??
    models[0]!;
  registry.setActive({ providerName: "cursor", modelId: selected.id });

  const stream = createProviderRegistryStreamFunction(registry, {
    resolveApiKey: () => apiKey,
  })(
    registry.buildActiveModel() as never,
    {
      systemPrompt:
        "Return one final line containing only the requested acceptance token. Do not call tools.",
      messages: [
        {
          role: "user",
          content: `End your response with a line containing exactly ${ACCEPTANCE_TOKEN}.`,
          timestamp: Date.now(),
        },
      ],
      tools: [],
    },
    { reasoning: "low" } as never,
  );

  const eventTypes: string[] = [];
  for await (const event of stream) eventTypes.push(event.type);
  const message = await stream.result();
  const responseText = assistantMessageToText(message).trim();
  if (message.stopReason !== "stop") {
    throw new Error(
      `Cursor live stream ended with ${message.stopReason}: ${message.errorMessage ?? "unknown error"}`,
    );
  }
  const responseLines = responseText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (responseLines.at(-1) !== ACCEPTANCE_TOKEN) {
    throw new Error(
      `Cursor live stream did not end with the acceptance token: ${JSON.stringify(responseText)}`,
    );
  }
  const text = ACCEPTANCE_TOKEN;

  const output = {
    provider: "cursor",
    catalogSource: "live",
    modelCount: models.length,
    model: selected.id,
    eventTypes,
    stopReason: message.stopReason,
    text,
  } as const;
  const serialized = JSON.stringify(output);
  if (serialized.includes(apiKey)) throw new Error("Cursor credential reached acceptance output.");
  if (FORBIDDEN_OUTPUT_FIELD.test(serialized)) {
    throw new Error("Credential-shaped field reached acceptance output.");
  }
  process.stdout.write(`${serialized}\n`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function resolveExistingCursorApiKey(): Promise<string | undefined> {
  if (process.env.CURSOR_API_KEY) return process.env.CURSOR_API_KEY;
  const store = new SparkAuthStore();
  await store.reload();
  for (const provider of ["cursor", "CURSOR_API_KEY"]) {
    const credential = store.get(provider);
    if (credential?.type === "api_key") return credential.apiKey;
  }
  return undefined;
}
