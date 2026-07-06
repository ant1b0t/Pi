// provider-opencode-go — OpenCode Go provider for Pi
//
// Overrides Pi's built-in opencode-go provider with the up-to-date model list
// from OpenCode's official documentation (https://opencode.ai/docs/go).
// Go is a $10/month subscription for curated open coding models.
//
// Endpoint: https://opencode.ai/zen/go/v1 (OpenAI-compatible)
//
// Usage:
//   pi -e extensions/provider-opencode-go.ts
//   pi -e extensions/provider-opencode-go.ts -e extensions/base/base-tools.ts
//
// Env:
//   OPENCODE_API_KEY       — API key from OpenCode Zen/Go console
//   OPENCODE_GO_BASE_URL   — optional base URL override
//
// Commands:
//   /opencode-go-login     — save API key locally
//   /opencode-go-logout    — remove saved API key
//   /opencode-go-status    — show auth and model status

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

type Api = "opencode-go-openai-completions";

const PROVIDER_ID = "opencode-go";
const API_KEY_ENV = "OPENCODE_API_KEY";
const BASE_URL_ENV = "OPENCODE_GO_BASE_URL";
const API_ID: Api = "opencode-go-openai-completions";
const DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1";
const AUTH_FILE = "opencode-go-auth.json";
const USER_AGENT = "PiOpenCodeGo/0.1";
const LOGIN_URL = "https://opencode.ai/auth";
const DOCS_URL = "https://opencode.ai/docs/go";

// ───── OpenCode Go models (from official docs, July 2026) ─────
//
// GLM-5.2          Kimi K2.7 Code    MiniMax M3       Qwen3.7 Max
// GLM-5.1          Kimi K2.6         MiniMax M2.7     Qwen3.7 Plus
//                                     MiniMax M2.5     Qwen3.6 Plus
// MiMo-V2.5                          DeepSeek V4 Pro
// MiMo-V2.5-Pro                      DeepSeek V4 Flash
//
// Deprecated (still in Go pricing table, removed from model list):
//   minimax-m2.5 — will be removed from Go on Aug 5, 2026

const GO_MODELS: Model<Api>[] = [
  // DeepSeek — V4 series
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro (OpenCode Go)",
    api: API_ID,
    provider: PROVIDER_ID,
    reasoning: true,
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    cost: { input: 1.74, output: 3.48, cacheRead: 0.0145, cacheWrite: 0 },
    compat: { supportsDeveloperRole: false },
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash (OpenCode Go)",
    api: API_ID,
    provider: PROVIDER_ID,
    reasoning: true,
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
    compat: { supportsDeveloperRole: false },
  },

  // GLM — 5 series
  {
    id: "glm-5.2",
    name: "GLM-5.2 (OpenCode Go)",
    api: API_ID,
    provider: PROVIDER_ID,
    reasoning: true,
    input: ["text"],
    contextWindow: 202_800,
    maxTokens: 32_800,
    cost: { input: 1.40, output: 4.40, cacheRead: 0.26, cacheWrite: 0 },
    compat: { supportsDeveloperRole: false },
  },
  {
    id: "glm-5.1",
    name: "GLM-5.1 (OpenCode Go)",
    api: API_ID,
    provider: PROVIDER_ID,
    reasoning: true,
    input: ["text"],
    contextWindow: 202_800,
    maxTokens: 32_800,
    cost: { input: 1.40, output: 4.40, cacheRead: 0.26, cacheWrite: 0 },
    compat: { supportsDeveloperRole: false },
  },

  // Kimi — K2 series
  {
    id: "kimi-k2.7-code",
    name: "Kimi K2.7 Code (OpenCode Go)",
    api: API_ID,
    provider: PROVIDER_ID,
    reasoning: true,
    input: ["text"],
    contextWindow: 262_100,
    maxTokens: 65_500,
    cost: { input: 0.95, output: 4.00, cacheRead: 0.19, cacheWrite: 0 },
    compat: { supportsDeveloperRole: false },
  },
  {
    id: "kimi-k2.6",
    name: "Kimi K2.6 (OpenCode Go)",
    api: API_ID,
    provider: PROVIDER_ID,
    reasoning: true,
    input: ["text"],
    contextWindow: 262_100,
    maxTokens: 65_500,
    cost: { input: 0.95, output: 4.00, cacheRead: 0.16, cacheWrite: 0 },
    compat: { supportsDeveloperRole: false },
  },

  // MiniMax — M3/M2 series
  {
    id: "minimax-m3",
    name: "MiniMax M3 (OpenCode Go)",
    api: API_ID,
    provider: PROVIDER_ID,
    reasoning: true,
    input: ["text"],
    contextWindow: 204_800,
    maxTokens: 131_072,
    cost: { input: 0.30, output: 1.20, cacheRead: 0.06, cacheWrite: 0 },
    compat: { supportsDeveloperRole: false },
  },
  {
    id: "minimax-m2.7",
    name: "MiniMax M2.7 (OpenCode Go)",
    api: API_ID,
    provider: PROVIDER_ID,
    reasoning: true,
    input: ["text"],
    contextWindow: 204_800,
    maxTokens: 131_072,
    cost: { input: 0.30, output: 1.20, cacheRead: 0.06, cacheWrite: 0 },
    compat: { supportsDeveloperRole: false },
  },
  {
    id: "minimax-m2.5",
    name: "MiniMax M2.5 (OpenCode Go)",
    api: API_ID,
    provider: PROVIDER_ID,
    reasoning: true,
    input: ["text"],
    contextWindow: 204_800,
    maxTokens: 65_500,
    cost: { input: 0.30, output: 1.20, cacheRead: 0.06, cacheWrite: 0.375 },
    compat: { supportsDeveloperRole: false },
  },

  // MiMo — V2.5 series
  {
    id: "mimo-v2.5",
    name: "MiMo V2.5 (OpenCode Go)",
    api: API_ID,
    provider: PROVIDER_ID,
    reasoning: true,
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
    compat: { supportsDeveloperRole: false },
  },
  {
    id: "mimo-v2.5-pro",
    name: "MiMo V2.5 Pro (OpenCode Go)",
    api: API_ID,
    provider: PROVIDER_ID,
    reasoning: true,
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: { input: 1.74, output: 3.48, cacheRead: 0.0145, cacheWrite: 0 },
    compat: { supportsDeveloperRole: false },
  },

  // Qwen — 3.7/3.6 series
  {
    id: "qwen3.7-max",
    name: "Qwen3.7 Max (OpenCode Go)",
    api: API_ID,
    provider: PROVIDER_ID,
    reasoning: true,
    input: ["text"],
    contextWindow: 262_100,
    maxTokens: 65_500,
    cost: { input: 2.50, output: 7.50, cacheRead: 0.50, cacheWrite: 3.125 },
    compat: { supportsDeveloperRole: false },
  },
  {
    id: "qwen3.7-plus",
    name: "Qwen3.7 Plus (OpenCode Go)",
    api: API_ID,
    provider: PROVIDER_ID,
    reasoning: true,
    input: ["text"],
    contextWindow: 262_100,
    maxTokens: 65_500,
    cost: { input: 0.40, output: 1.60, cacheRead: 0.04, cacheWrite: 0.50 },
    compat: { supportsDeveloperRole: false },
  },
  {
    id: "qwen3.6-plus",
    name: "Qwen3.6 Plus (OpenCode Go)",
    api: API_ID,
    provider: PROVIDER_ID,
    reasoning: true,
    input: ["text"],
    contextWindow: 262_100,
    maxTokens: 65_500,
    cost: { input: 0.50, output: 3.00, cacheRead: 0.05, cacheWrite: 0.625 },
    compat: { supportsDeveloperRole: false },
  },
];

// ───── Auth helpers ─────

type OpenCodeGoAuth = {
  apiKey: string;
  savedAt: number;
};

function getPiAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function getAuthPath(): string {
  return join(getPiAgentDir(), AUTH_FILE);
}

function loadAuth(): OpenCodeGoAuth | undefined {
  try {
    const authPath = getAuthPath();
    if (!existsSync(authPath)) return undefined;
    const data = JSON.parse(readFileSync(authPath, "utf8")) as Partial<OpenCodeGoAuth>;
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
    JSON.stringify({ apiKey: apiKey.trim(), savedAt: Date.now() } satisfies OpenCodeGoAuth, null, 2),
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

function createErrorEvent(model: Model<Api>, message: string) {
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
      errorMessage: message,
      timestamp: Date.now(),
    },
  };
}

function streamOpenCodeGo(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const apiKey = getResolvedApiKey(options);
    const baseUrl = normalizeBaseUrl(resolveEnv(BASE_URL_ENV) || DEFAULT_BASE_URL);

    if (!apiKey) {
      stream.push(
        createErrorEvent(
          model,
          `Missing ${API_KEY_ENV}. Subscribe at ${LOGIN_URL} and set ${API_KEY_ENV} or use /opencode-go-login.`,
        ),
      );
      stream.end();
      return;
    }

    const modelWithBaseUrl = { ...model, baseUrl } as Model<Api>;

    try {
      const innerStream = streamSimpleOpenAICompletions(modelWithBaseUrl, context, {
        ...options,
        apiKey,
        headers: {
          ...options?.headers,
          "User-Agent": USER_AGENT,
        },
      });

      for await (const event of innerStream) {
        stream.push(patchProviderMetadata(event, PROVIDER_ID, API_ID));
      }
      stream.end();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      stream.push(createErrorEvent(model, `OpenCode Go error: ${msg}`));
      stream.end();
    }
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
  const apiKey = resolveEnv(API_KEY_ENV);

  pi.registerProvider(PROVIDER_ID, {
    baseUrl,
    apiKey: API_KEY_ENV,
    api: API_ID,
    headers: {
      "User-Agent": USER_AGENT,
    },
    models: GO_MODELS,
    streamSimple: streamOpenCodeGo,
  });

  // ─── Commands ───

  pi.registerCommand("opencode-go-login", {
    description: "Save OpenCode Go API key for the Go subscription gateway",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui?.notify(
          `Interactive login requires UI. Subscribe at ${LOGIN_URL} and set ${API_KEY_ENV} in your environment or .env file.`,
          "error",
        );
        return;
      }

      ctx.ui.notify(
        [
          `OpenCode Go login: ${LOGIN_URL}`,
          `Gateway: ${baseUrl}`,
          `Models: ${GO_MODELS.length} curated open models`,
          `Docs: ${DOCS_URL}`,
        ].join("\n"),
        "info",
      );

      const result = await ctx.ui.input("Enter your OpenCode Go / Zen API key:");
      if (result === null || result === undefined) {
        ctx.ui.notify("Login cancelled", "info");
        return;
      }

      const key = String(result).trim();
      if (!key) {
        ctx.ui.notify("API key cannot be empty", "error");
        return;
      }

      try {
        saveAuth(key);
        ctx.ui.notify(`OpenCode Go API key saved. Priority: env → saved key → .env`, "success");
      } catch (err) {
        ctx.ui.notify(
          `Failed to save API key: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("opencode-go-logout", {
    description: "Remove saved OpenCode Go API key",
    handler: async (_args, ctx) => {
      const saved = loadAuth();
      if (!saved?.apiKey) {
        ctx.ui.notify("No saved OpenCode Go API key found", "info");
        return;
      }
      clearAuth();
      ctx.ui.notify("Saved OpenCode Go API key removed", "success");
    },
  });

  pi.registerCommand("opencode-go-status", {
    description: "Show OpenCode Go auth and model status",
    handler: async (_args, ctx) => {
      const sources = getAuthSources();
      const effectiveBaseUrl = normalizeBaseUrl(resolveEnv(BASE_URL_ENV) || DEFAULT_BASE_URL);
      const hasKey = !!resolveEnv(API_KEY_ENV);

      if (sources.length === 0) {
        ctx.ui.notify(
          [
            `OpenCode Go: Not authenticated.`,
            `Subscribe at ${LOGIN_URL}`,
            `Set ${API_KEY_ENV} or use /opencode-go-login.`,
            `Gateway: ${effectiveBaseUrl}`,
            `Available models: ${GO_MODELS.length}`,
          ].join("\n"),
          "warning",
        );
        return;
      }

      ctx.ui.notify(
        [
          `OpenCode Go: Authenticated.`,
          `Key source: ${sources.join(" → ")}`,
          hasKey ? "" : "(no key found despite saved source — check env or saved key)",
          `Gateway: ${effectiveBaseUrl}`,
          `Available models: ${GO_MODELS.length}`,
          ...GO_MODELS.map((m) => `  • ${m.id}`),
        ]
          .filter(Boolean)
          .join("\n"),
        "success",
      );
    },
  });

  console.log(`[OpenCode Go] Registered provider ${PROVIDER_ID}`);
  console.log(`[OpenCode Go] Base URL: ${baseUrl}`);
  console.log(`[OpenCode Go] Models: ${GO_MODELS.length} curated open models`);
  console.log(`[OpenCode Go] Commands: /opencode-go-login, /opencode-go-logout, /opencode-go-status`);
}
