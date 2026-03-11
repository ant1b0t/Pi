import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  streamSimpleOpenAICompletions,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";

type Api = "openai-completions";
type ErrorCode =
  | "MISSING_API_KEY"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  | "UNSUPPORTED_MODEL"
  | "MODEL_UNAVAILABLE"
  | "PRODUCTION_WARNING"
  | "INTERNAL_ERROR";

type ClassifiedError = {
  code: ErrorCode;
  message: string;
  actionHint: string;
  retryable: boolean;
  allowFallback: boolean;
};

type OpenCodeZenAuth = {
  apiKey: string;
  savedAt: number;
};

const PROVIDER_ID = "opencode-zen";
const API_KEY_ENV = "OPENCODE_ZEN_API_KEY";
const BASE_URL_ENV = "OPENCODE_ZEN_BASE_URL";
const DEFAULT_MODEL_ENV = "OPENCODE_ZEN_DEFAULT_MODEL";
const FALLBACK_MODEL_ENV = "OPENCODE_ZEN_FALLBACK_MODEL";
const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";
const DEFAULT_MODEL = "minimax-m2.5-free";
const FALLBACK_MODEL = "minimax-m2.5";
const AUTH_FILE = "opencode-zen-auth.json";
const USER_AGENT = "PiOpenCodeZen/0.1";
const LOGIN_URL = "https://opencode.ai/ru/zen";
const DOCS_URL = "https://platform.minimax.io/docs/coding-plan/opencode";
const PROD_WARNING =
  "The free model is treated as limited-time and not suitable for sensitive production code without separate confirmation.";

function getPiAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function getAuthPath(): string {
  return join(getPiAgentDir(), AUTH_FILE);
}

function loadAuth(): OpenCodeZenAuth | undefined {
  try {
    const authPath = getAuthPath();
    if (!existsSync(authPath)) return undefined;
    const data = JSON.parse(readFileSync(authPath, "utf8")) as Partial<OpenCodeZenAuth>;
    if (!data.apiKey || typeof data.apiKey !== "string") return undefined;
    return {
      apiKey: data.apiKey,
      savedAt: typeof data.savedAt === "number" ? data.savedAt : Date.now(),
    };
  } catch {
    return undefined;
  }
}

function saveAuth(apiKey: string): void {
  const agentDir = getPiAgentDir();
  if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    getAuthPath(),
    JSON.stringify({ apiKey: apiKey.trim(), savedAt: Date.now() } satisfies OpenCodeZenAuth, null, 2),
  );
}

function clearAuth(): void {
  try {
    const authPath = getAuthPath();
    if (existsSync(authPath)) writeFileSync(authPath, JSON.stringify({}, null, 2));
  } catch {
    // ignore
  }
}

function readDotEnvValue(name: string): string | undefined {
  try {
    const envPath = join(process.cwd(), ".env");
    if (!existsSync(envPath)) return undefined;
    const text = readFileSync(envPath, "utf8");

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      if (key !== name) continue;
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return value || undefined;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function resolveEnv(name: string): string | undefined {
  const envValue = process.env[name]?.trim();
  if (envValue) return envValue;

  if (name === API_KEY_ENV) {
    const saved = loadAuth();
    if (saved?.apiKey) return saved.apiKey;
  }

  return readDotEnvValue(name);
}

function normalizeBaseUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function normalizeModelId(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function getConfiguredDefaultModel(): string {
  return normalizeModelId(resolveEnv(DEFAULT_MODEL_ENV), DEFAULT_MODEL);
}

function getConfiguredFallbackModel(): string {
  return normalizeModelId(resolveEnv(FALLBACK_MODEL_ENV), FALLBACK_MODEL);
}

function isConfiguredDefaultModel(modelId: string): boolean {
  return modelId === getConfiguredDefaultModel();
}

function getResolvedApiKey(options?: SimpleStreamOptions): string | undefined {
  const direct = options?.apiKey?.trim();
  if (direct && direct !== API_KEY_ENV) return direct;
  return resolveEnv(API_KEY_ENV);
}

function patchProviderMetadata(event: any, provider: string, api: Api) {
  const patchMessage = (message: any) => {
    if (!message || typeof message !== "object") return;
    message.provider = provider;
    message.api = api;
  };

  if (!event || typeof event !== "object") return event;
  if ("partial" in event) patchMessage(event.partial);
  if ("message" in event) patchMessage(event.message);
  if ("error" in event) patchMessage(event.error);
  return event;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return safeStringify(error);
}

function classifyError(error: unknown, modelId: string): ClassifiedError {
  const raw = extractErrorMessage(error);
  const message = raw.toLowerCase();

  if (!raw.trim()) {
    return {
      code: "INTERNAL_ERROR",
      message: "Unknown OpenCode Zen error.",
      actionHint: "Retry once. If the problem persists, switch to the paid model or inspect the gateway response.",
      retryable: true,
      allowFallback: isConfiguredDefaultModel(modelId) && modelId.includes("free"),
    };
  }

  if (message.includes("missing opencode_zen_api_key") || message.includes(`missing ${API_KEY_ENV.toLowerCase()}`)) {
    return {
      code: "MISSING_API_KEY",
      message: `Missing ${API_KEY_ENV}.`,
      actionHint: `Log in at ${LOGIN_URL}, get a token/key there, then set ${API_KEY_ENV} in your environment, .env, or use /opencode-zen-login.`,
      retryable: false,
      allowFallback: false,
    };
  }

  if (
    message.includes("401") ||
    message.includes("unauthorized") ||
    message.includes("incorrect api key") ||
    message.includes("invalid api key") ||
    message.includes("authentication failed")
  ) {
    return {
      code: "UNAUTHORIZED",
      message: "OpenCode Zen rejected the API key.",
      actionHint: `Verify ${API_KEY_ENV} and ensure it grants access to the Zen gateway.`,
      retryable: false,
      allowFallback: false,
    };
  }

  if (message.includes("403") || message.includes("forbidden") || message.includes("permission") || message.includes("access denied")) {
    return {
      code: "FORBIDDEN",
      message: "The API key is valid but lacks permission for this model or gateway.",
      actionHint: "Check account entitlements for OpenCode Zen and MiniMax access.",
      retryable: false,
      allowFallback: false,
    };
  }

  if (
    message.includes("429") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("quota")
  ) {
    const isQuota = message.includes("quota") || message.includes("insufficient_quota") || message.includes("credit");
    return {
      code: isQuota ? "QUOTA_EXCEEDED" : "RATE_LIMITED",
      message: isQuota ? "Quota exceeded for OpenCode Zen / MiniMax." : "Rate limited by OpenCode Zen.",
      actionHint: isQuota
        ? "Wait for quota reset or switch manually to an entitled paid path after confirming cost implications."
        : "Back off and retry later. Automatic fallback is intentionally disabled for rate-limit cases.",
      retryable: !isQuota,
      allowFallback: false,
    };
  }

  if (
    message.includes("model_not_found") ||
    message.includes("unsupported model") ||
    message.includes("invalid model") ||
    message.includes("does not exist") ||
    message.includes("not supported")
  ) {
    const isFree = modelId.includes("free");
    return {
      code: "UNSUPPORTED_MODEL",
      message: isFree
        ? `The free model '${modelId}' is unsupported or no longer available on this gateway.`
        : `The model '${modelId}' is unsupported on this gateway.`,
      actionHint: isFree
        ? `Pi can fall back to '${getConfiguredFallbackModel()}'. If you selected the free model intentionally, treat it as limited-time only.`
        : `Use '${DEFAULT_MODEL}' or '${getConfiguredFallbackModel()}', or update ${DEFAULT_MODEL_ENV}.`,
      retryable: false,
      allowFallback: isConfiguredDefaultModel(modelId) && isFree,
    };
  }

  if (
    message.includes("503") ||
    message.includes("502") ||
    message.includes("504") ||
    message.includes("service unavailable") ||
    message.includes("temporarily unavailable") ||
    message.includes("capacity") ||
    message.includes("overloaded")
  ) {
    const isFree = modelId.includes("free");
    return {
      code: "MODEL_UNAVAILABLE",
      message: isFree
        ? `The free model '${modelId}' is temporarily unavailable.`
        : `The model '${modelId}' is temporarily unavailable.`,
      actionHint: isFree
        ? `Pi can retry via '${getConfiguredFallbackModel()}', but treat the free model as non-production and limited-time.`
        : "Retry later or choose a different model.",
      retryable: true,
      allowFallback: isConfiguredDefaultModel(modelId) && isFree,
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: raw,
    actionHint: "Inspect the gateway response. If the error is specific to the free model, switch manually or adjust the default model.",
    retryable: true,
    allowFallback: isConfiguredDefaultModel(modelId) && modelId.includes("free"),
  };
}

function createErrorEvent(model: Model<Api>, error: unknown) {
  const classified = classifyError(error, model.id);
  const structured = JSON.stringify({
    code: classified.code,
    message: classified.message,
    action_hint: classified.actionHint,
    retryable: classified.retryable,
  });

  return {
    type: "error" as const,
    reason: "error" as const,
    error: {
      role: "assistant" as const,
      content: [],
      api: model.api,
      provider: PROVIDER_ID,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error" as const,
      errorMessage: structured,
      timestamp: Date.now(),
    },
  };
}

async function forwardInnerStream(params: {
  stream: AssistantMessageEventStream;
  model: Model<Api>;
  context: Context;
  options?: SimpleStreamOptions;
  chosenModelId: string;
  apiKey: string;
  baseUrl: string;
}) {
  const modelWithBaseUrl = {
    ...params.model,
    id: params.chosenModelId,
    baseUrl: params.baseUrl,
  } as Model<Api>;

  const innerStream = streamSimpleOpenAICompletions(modelWithBaseUrl, params.context, {
    ...params.options,
    apiKey: params.apiKey,
    headers: {
      ...params.options?.headers,
      "User-Agent": USER_AGENT,
    },
  });

  for await (const event of innerStream) {
    params.stream.push(patchProviderMetadata(event, PROVIDER_ID, "openai-completions"));
  }
}

function buildAttemptChain(requestedModelId: string): string[] {
  const defaultModel = getConfiguredDefaultModel();
  const fallbackModel = getConfiguredFallbackModel();
  if (requestedModelId !== defaultModel || requestedModelId === fallbackModel) return [requestedModelId];
  return [requestedModelId, fallbackModel];
}

function buildModelDefinition(id: string) {
  const isFree = id.includes("free");
  const isPrimaryFree = id === DEFAULT_MODEL;
  const isPrimaryPaid = id === FALLBACK_MODEL;

  return {
    id,
    name: isPrimaryFree
      ? "MiniMax M2.5 Free (OpenCode Zen)"
      : isPrimaryPaid
        ? "MiniMax M2.5 (OpenCode Zen)"
        : `${id} (OpenCode Zen)`,
    reasoning: true,
    input: ["text"] as ("text")[],
    cost: isFree
      ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      : { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.12 },
    contextWindow: 200000,
    maxTokens: 8192,
    compat: {
      supportsDeveloperRole: false,
    },
  };
}

function buildRegisteredModels(defaultModel: string, fallbackModel: string) {
  const ordered = [defaultModel, fallbackModel, DEFAULT_MODEL, FALLBACK_MODEL];
  const seen = new Set<string>();
  return ordered
    .filter((id) => {
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map(buildModelDefinition);
}

function streamOpenCodeZen(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const apiKey = getResolvedApiKey(options);
    const baseUrl = normalizeBaseUrl(resolveEnv(BASE_URL_ENV) || DEFAULT_BASE_URL);

    if (!apiKey) {
      stream.push(createErrorEvent(model, new Error(`Missing ${API_KEY_ENV}`)));
      stream.end();
      return;
    }

    const attemptChain = buildAttemptChain(model.id);
    let lastError: unknown;

    for (let index = 0; index < attemptChain.length; index++) {
      const chosenModelId = attemptChain[index];
      try {
        await forwardInnerStream({ stream, model, context, options, chosenModelId, apiKey, baseUrl });
        stream.end();
        return;
      } catch (error) {
        lastError = error;
        const classified = classifyError(error, chosenModelId);
        const hasAnotherAttempt = index < attemptChain.length - 1;
        if (classified.allowFallback && hasAnotherAttempt) {
          continue;
        }
        stream.push(createErrorEvent({ ...model, id: chosenModelId } as Model<Api>, error));
        stream.end();
        return;
      }
    }

    stream.push(createErrorEvent(model, lastError ?? new Error("OpenCode Zen request failed.")));
    stream.end();
  })();

  return stream;
}

function getAuthSources(): string[] {
  const envKey = process.env[API_KEY_ENV]?.trim();
  const saved = loadAuth();
  const dotenv = readDotEnvValue(API_KEY_ENV);

  const sources: string[] = [];
  if (envKey) sources.push("environment variable");
  if (saved?.apiKey) sources.push(`saved key (${new Date(saved.savedAt).toLocaleDateString()})`);
  if (dotenv) sources.push(".env file");
  return sources;
}

export default function (pi: ExtensionAPI) {
  const baseUrl = normalizeBaseUrl(resolveEnv(BASE_URL_ENV) || DEFAULT_BASE_URL);
  const defaultModel = getConfiguredDefaultModel();
  const fallbackModel = getConfiguredFallbackModel();

  pi.registerProvider(PROVIDER_ID, {
    baseUrl,
    apiKey: API_KEY_ENV,
    api: "openai-completions",
    headers: {
      "User-Agent": USER_AGENT,
    },
    models: buildRegisteredModels(defaultModel, fallbackModel),
    streamSimple: streamOpenCodeZen,
  });

  pi.registerCommand("opencode-zen-login", {
    description: "Save OpenCode Zen API key for the MiniMax OpenAI-compatible gateway",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui?.notify(`Interactive login requires UI. Set ${API_KEY_ENV} in your environment or .env file.`, "error");
        return;
      }

      ctx.ui.notify(
        [
          `OpenCode Zen login: ${LOGIN_URL}`,
          `OpenCode Zen gateway: ${baseUrl}`,
          `Primary model: ${defaultModel}`,
          `Fallback model: ${fallbackModel}`,
          PROD_WARNING,
          `Reference setup: ${DOCS_URL}`,
        ].join("\n"),
        "info",
      );

      const result = await ctx.ui.input("Enter your OpenCode Zen token / API key:");
      if (result === null || result === undefined) {
        ctx.ui.notify("Login cancelled", "info");
        return;
      }

      const apiKey = String(result).trim();
      if (!apiKey) {
        ctx.ui.notify("API key cannot be empty", "error");
        return;
      }

      try {
        saveAuth(apiKey);
        ctx.ui.notify(`OpenCode Zen API key saved. Priority: env → saved key → .env`, "success");
      } catch (err) {
        ctx.ui.notify(`Failed to save API key: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("opencode-zen-logout", {
    description: "Remove saved OpenCode Zen API key",
    handler: async (_args, ctx) => {
      const saved = loadAuth();
      if (!saved?.apiKey) {
        ctx.ui.notify("No saved OpenCode Zen API key found", "info");
        return;
      }
      clearAuth();
      ctx.ui.notify("Saved OpenCode Zen API key removed", "success");
    },
  });

  pi.registerCommand("opencode-zen-status", {
    description: "Show OpenCode Zen auth status, model config, and safety warning",
    handler: async (_args, ctx) => {
      const sources = getAuthSources();
      const effectiveBaseUrl = normalizeBaseUrl(resolveEnv(BASE_URL_ENV) || DEFAULT_BASE_URL);
      const effectiveDefaultModel = getConfiguredDefaultModel();
      const effectiveFallbackModel = getConfiguredFallbackModel();

      if (sources.length === 0) {
        ctx.ui.notify(
          [
            `OpenCode Zen: Not authenticated.`,
            `Log in here to obtain a token/key: ${LOGIN_URL}`,
            `Set ${API_KEY_ENV} or use /opencode-zen-login.`,
            `Gateway: ${effectiveBaseUrl}`,
            `Default model: ${effectiveDefaultModel}`,
            `Fallback model: ${effectiveFallbackModel}`,
            PROD_WARNING,
          ].join("\n"),
          "warning",
        );
        return;
      }

      ctx.ui.notify(
        [
          `OpenCode Zen: Authenticated.`,
          `Key source: ${sources.join(" → ")}`,
          `Gateway: ${effectiveBaseUrl}`,
          `Default model: ${effectiveDefaultModel}`,
          `Fallback model: ${effectiveFallbackModel}`,
          `Supported models in this extension: ${DEFAULT_MODEL}, ${FALLBACK_MODEL}`,
          PROD_WARNING,
        ].join("\n"),
        effectiveDefaultModel === DEFAULT_MODEL ? "warning" : "success",
      );
    },
  });

  console.log(`[OpenCode Zen] Registered provider ${PROVIDER_ID}`);
  console.log(`[OpenCode Zen] Base URL: ${baseUrl}`);
  console.log(`[OpenCode Zen] Default model: ${defaultModel}; fallback: ${fallbackModel}`);
  console.log(`[OpenCode Zen] Commands: /opencode-zen-login, /opencode-zen-logout, /opencode-zen-status`);
}
