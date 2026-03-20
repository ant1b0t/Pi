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

type Api = "xiaomi-openai-completions";
type ErrorCode =
  | "MISSING_API_KEY"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  | "UNSUPPORTED_MODEL"
  | "MODEL_UNAVAILABLE"
  | "INTERNAL_ERROR";

type ClassifiedError = {
  code: ErrorCode;
  message: string;
  actionHint: string;
  retryable: boolean;
  allowFallback: boolean;
};

type XiaomiAuth = {
  apiKey: string;
  savedAt: number;
};

const PROVIDER_ID = "xiaomi";
const API_KEY_ENV = "XIAOMI_API_KEY";
const BASE_URL_ENV = "XIAOMI_BASE_URL";
const DEFAULT_MODEL_ENV = "XIAOMI_DEFAULT_MODEL";
const FALLBACK_MODEL_ENV = "XIAOMI_FALLBACK_MODEL";
const API_ID: Api = "xiaomi-openai-completions";
const DEFAULT_BASE_URL = "https://api.xiaomimimo.com/v1";
const DEFAULT_MODEL = "mimo-v2-pro";
const AUTH_FILE = "xiaomi-auth.json";
const USER_AGENT = "PiXiaomi/0.1";
const LOGIN_URL = "https://platform.xiaomimimo.com/";
const DOCS_URL = "https://platform.xiaomimimo.com/";

function getPiAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function getAuthPath(): string {
  return join(getPiAgentDir(), AUTH_FILE);
}

function loadAuth(): XiaomiAuth | undefined {
  try {
    const authPath = getAuthPath();
    if (!existsSync(authPath)) return undefined;
    const data = JSON.parse(readFileSync(authPath, "utf8")) as Partial<XiaomiAuth>;
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
    JSON.stringify({ apiKey: apiKey.trim(), savedAt: Date.now() } satisfies XiaomiAuth, null, 2),
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

function normalizeModelId(value: string | undefined, fallback?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function getConfiguredDefaultModel(): string {
  return normalizeModelId(resolveEnv(DEFAULT_MODEL_ENV), DEFAULT_MODEL) || DEFAULT_MODEL;
}

function getConfiguredFallbackModel(): string | undefined {
  return normalizeModelId(resolveEnv(FALLBACK_MODEL_ENV));
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
  const fallbackModel = getConfiguredFallbackModel();

  if (!raw.trim()) {
    return {
      code: "INTERNAL_ERROR",
      message: "Unknown Xiaomi MiMo error.",
      actionHint: "Retry once. If the problem persists, inspect the API response and Xiaomi platform status.",
      retryable: true,
      allowFallback: Boolean(fallbackModel && isConfiguredDefaultModel(modelId) && modelId !== fallbackModel),
    };
  }

  if (message.includes(`missing ${API_KEY_ENV.toLowerCase()}`) || message.includes("missing api key")) {
    return {
      code: "MISSING_API_KEY",
      message: `Missing ${API_KEY_ENV}.`,
      actionHint: `Create a key at ${LOGIN_URL}, then set ${API_KEY_ENV} in your environment, .env, or use /xiaomi-login.`,
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
      message: "Xiaomi MiMo rejected the API key.",
      actionHint: `Verify ${API_KEY_ENV} and ensure your key is active on ${LOGIN_URL}.`,
      retryable: false,
      allowFallback: false,
    };
  }

  if (message.includes("403") || message.includes("forbidden") || message.includes("permission") || message.includes("access denied")) {
    return {
      code: "FORBIDDEN",
      message: "The API key is valid but lacks permission for this Xiaomi MiMo model or account.",
      actionHint: "Check project access, billing, and model entitlements in the Xiaomi MiMo platform.",
      retryable: false,
      allowFallback: false,
    };
  }

  if (message.includes("429") || message.includes("rate limit") || message.includes("too many requests") || message.includes("quota")) {
    const isQuota = message.includes("quota") || message.includes("insufficient_quota") || message.includes("credit");
    return {
      code: isQuota ? "QUOTA_EXCEEDED" : "RATE_LIMITED",
      message: isQuota ? "Quota exceeded for Xiaomi MiMo." : "Rate limited by Xiaomi MiMo.",
      actionHint: isQuota ? "Check billing/quota on the Xiaomi MiMo platform." : "Back off and retry later.",
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
    return {
      code: "UNSUPPORTED_MODEL",
      message: `The model '${modelId}' is unsupported on this Xiaomi MiMo gateway.`,
      actionHint: `Use '${DEFAULT_MODEL}' or update ${DEFAULT_MODEL_ENV}.`,
      retryable: false,
      allowFallback: Boolean(fallbackModel && isConfiguredDefaultModel(modelId) && modelId !== fallbackModel),
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
    return {
      code: "MODEL_UNAVAILABLE",
      message: `The model '${modelId}' is temporarily unavailable.`,
      actionHint: "Retry later or choose a different model.",
      retryable: true,
      allowFallback: Boolean(fallbackModel && isConfiguredDefaultModel(modelId) && modelId !== fallbackModel),
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: raw,
    actionHint: "Inspect the Xiaomi MiMo API response and retry if appropriate.",
    retryable: true,
    allowFallback: Boolean(fallbackModel && isConfiguredDefaultModel(modelId) && modelId !== fallbackModel),
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
    params.stream.push(patchProviderMetadata(event, PROVIDER_ID, API_ID));
  }
}

function buildAttemptChain(requestedModelId: string): string[] {
  const fallbackModel = getConfiguredFallbackModel();
  if (!fallbackModel || requestedModelId !== getConfiguredDefaultModel() || requestedModelId === fallbackModel) {
    return [requestedModelId];
  }
  return [requestedModelId, fallbackModel];
}

function buildModelDefinition(id: string) {
  return {
    id,
    name: id === DEFAULT_MODEL ? "Xiaomi MiMo V2 Pro" : `${id} (Xiaomi MiMo)`,
    reasoning: true,
    input: ["text"] as ("text")[],
    cost: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 1048576, // unverified in official public docs; keep provisional until Xiaomi exposes model metadata/docs
    maxTokens: 131072, // confirmed empirically by Xiaomi API error response for mimo-v2-pro
    compat: {
      supportsDeveloperRole: true, // confirmed empirically by successful developer-role request
    },
  };
}

function buildRegisteredModels(defaultModel: string, fallbackModel?: string) {
  const ordered = [defaultModel, fallbackModel, DEFAULT_MODEL];
  const seen = new Set<string>();
  return ordered
    .filter((id): id is string => {
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map(buildModelDefinition);
}

function streamXiaomi(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
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
        if (classified.allowFallback && hasAnotherAttempt) continue;
        stream.push(createErrorEvent({ ...model, id: chosenModelId } as Model<Api>, error));
        stream.end();
        return;
      }
    }

    stream.push(createErrorEvent(model, lastError ?? new Error("Xiaomi MiMo request failed.")));
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
    api: API_ID,
    headers: {
      "User-Agent": USER_AGENT,
    },
    models: buildRegisteredModels(defaultModel, fallbackModel),
    streamSimple: streamXiaomi,
  });

  pi.registerCommand("xiaomi-login", {
    description: "Save Xiaomi MiMo API key",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui?.notify(`Interactive login requires UI. Set ${API_KEY_ENV} in your environment or .env file.`, "error");
        return;
      }

      ctx.ui.notify(
        [
          `Xiaomi MiMo login: ${LOGIN_URL}`,
          `Xiaomi MiMo gateway: ${baseUrl}`,
          `Default model: ${defaultModel}`,
          fallbackModel ? `Fallback model: ${fallbackModel}` : "Fallback model: none",
          `Reference docs: ${DOCS_URL}`,
        ].join("\n"),
        "info",
      );

      const result = await ctx.ui.input("Enter your Xiaomi MiMo API key:");
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
        ctx.ui.notify(`Xiaomi MiMo API key saved. Priority: env → saved key → .env`, "success");
      } catch (err) {
        ctx.ui.notify(`Failed to save API key: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("xiaomi-logout", {
    description: "Remove saved Xiaomi MiMo API key",
    handler: async (_args, ctx) => {
      const saved = loadAuth();
      if (!saved?.apiKey) {
        ctx.ui.notify("No saved Xiaomi MiMo API key found", "info");
        return;
      }
      clearAuth();
      ctx.ui.notify("Saved Xiaomi MiMo API key removed", "success");
    },
  });

  pi.registerCommand("xiaomi-status", {
    description: "Show Xiaomi MiMo auth status and model config",
    handler: async (_args, ctx) => {
      const sources = getAuthSources();
      const effectiveBaseUrl = normalizeBaseUrl(resolveEnv(BASE_URL_ENV) || DEFAULT_BASE_URL);
      const effectiveDefaultModel = getConfiguredDefaultModel();
      const effectiveFallbackModel = getConfiguredFallbackModel();

      if (sources.length === 0) {
        ctx.ui.notify(
          [
            `Xiaomi MiMo: Not authenticated.`,
            `Create a key here: ${LOGIN_URL}`,
            `Set ${API_KEY_ENV} or use /xiaomi-login.`,
            `Gateway: ${effectiveBaseUrl}`,
            `Default model: ${effectiveDefaultModel}`,
            effectiveFallbackModel ? `Fallback model: ${effectiveFallbackModel}` : "Fallback model: none",
          ].join("\n"),
          "warning",
        );
        return;
      }

      ctx.ui.notify(
        [
          `Xiaomi MiMo: Authenticated.`,
          `Key source: ${sources.join(" → ")}`,
          `Gateway: ${effectiveBaseUrl}`,
          `Default model: ${effectiveDefaultModel}`,
          effectiveFallbackModel ? `Fallback model: ${effectiveFallbackModel}` : "Fallback model: none",
          `Supported models in this extension: ${buildRegisteredModels(effectiveDefaultModel, effectiveFallbackModel)
            .map((model) => model.id)
            .join(", ")}`,
        ].join("\n"),
        "success",
      );
    },
  });

  console.log(`[Xiaomi MiMo] Registered provider ${PROVIDER_ID}`);
  console.log(`[Xiaomi MiMo] Base URL: ${baseUrl}`);
  console.log(`[Xiaomi MiMo] Default model: ${defaultModel}; fallback: ${fallbackModel || "none"}`);
  console.log(`[Xiaomi MiMo] Commands: /xiaomi-login, /xiaomi-logout, /xiaomi-status`);
}
