// 📁 provider-smartrouter.ts — SmartRouter OpenAI-compatible provider for Pi.
// 🎯 Core function: Load smartrouter.env, configure proxy/direct transport, register provider + diagnostics commands.
// 🔗 Key dependencies: @mariozechner/pi-coding-agent, @mariozechner/pi-ai, node:fs/path/url/os.
// 💡 Usage: Load globally via ~/.pi/agent/settings.json or run with `pi -e extensions/provider-smartrouter.ts`.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  streamOpenAICompletions,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getScopedTransport } from "./lib/proxy-config.ts";

type Api = "smartrouter-openai-completions";

const SMARTROUTER_PROVIDER_ID = "smartrouter";
const SMARTROUTER_API_ID: Api = "smartrouter-openai-completions";
const SMARTROUTER_API_KEY_ENV = "SMARTROUTER_API_KEY";
const SMARTROUTER_ADMIN_TOKEN_ENV = "SMARTROUTER_ADMIN_TOKEN";
const SMARTROUTER_ENV_BASENAME = "smartrouter.env";
const SMARTROUTER_USER_AGENT = "PiSmartRouter/0.1";
const SMARTROUTER_STREAM_TRANSPORT_ENV = "SMARTROUTER_STREAM_TRANSPORT";

type SmartRouterStreamTransportMode = "direct" | "proxy";

type SmartRouterErrorCode =
  | "MISSING_API_KEY"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "UNSUPPORTED_MODEL"
  | "CONNECTION_ERROR"
  | "INTERNAL_ERROR";

interface ClassifiedSmartRouterError {
  code: SmartRouterErrorCode;
  message: string;
  actionHint: string;
  retryable: boolean;
}

function getSmartRouterStreamTransportMode(): SmartRouterStreamTransportMode {
  const raw = String(process.env[SMARTROUTER_STREAM_TRANSPORT_ENV] || "").trim().toLowerCase();
  return raw === "direct" ? "direct" : "proxy";
}

function formatProxyEnv(proxyEnv: Record<string, string>): string {
  return Object.keys(proxyEnv).length
    ? Object.entries(proxyEnv).map(([key, value]) => `${key}=${value}`).join(", ")
    : "not configured";
}

function createScopedFetchHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  return headers && Object.keys(headers).length > 0
    ? { ...headers }
    : undefined;
}

function parseSmartRouterEnvFile(envPath: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!existsSync(envPath)) return out;

	const lines = readFileSync(envPath, "utf-8").split("\n");
	for (const raw of lines) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;

		const eqIdx = line.indexOf("=");
		if (eqIdx === -1) continue;

		const key = line.slice(0, eqIdx).trim();
		const value = line.slice(eqIdx + 1).trim();
		if (!key) continue;

		out[key] = value;
	}
	return out;
}

/**
 * Merges SmartRouter env files into process.env.
 * * Precedence (later layers override earlier): ~/.pi/smartrouter.env, then <cwd>/.pi/smartrouter.env,
 *   then extensions/smartrouter.env next to this module.
 * * Shell-exported variables are never overwritten.
 */
function loadSmartRouterEnvFile(): void {
	const thisDir = dirname(fileURLToPath(import.meta.url));
	const paths = [
		join(homedir(), ".pi", SMARTROUTER_ENV_BASENAME),
		join(process.cwd(), ".pi", SMARTROUTER_ENV_BASENAME),
		join(thisDir, SMARTROUTER_ENV_BASENAME),
	];

	const merged: Record<string, string> = {};
	for (const envPath of paths) {
		const chunk = parseSmartRouterEnvFile(envPath);
		Object.assign(merged, chunk);
	}

	for (const [key, value] of Object.entries(merged)) {
		if (!process.env[key]) {
			process.env[key] = value;
		}
	}
}

interface SmartRouterModelSeed {
  id: string;
  name: string;
  /** * Pi sends reasoning when true; SmartRouter maps it to upstream `reasoning_effort`. */
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
}

const SMARTROUTER_MODEL_SEEDS: SmartRouterModelSeed[] = [
	// * GitHub Copilot
	{
		id: "github-copilot/claude-haiku-4.5",
		name: "Copilot · Claude Haiku 4.5",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 128000,
		maxTokens: 16384,
		compat: { supportsDeveloperRole: false },
	},
	{
		id: "github-copilot/claude-opus-4.6",
		name: "Copilot · Claude Opus 4.6",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 128000,
		maxTokens: 16384,
		compat: { supportsDeveloperRole: false },
	},
	{
		id: "github-copilot/claude-sonnet-4.6",
		name: "Copilot · Claude Sonnet 4.6",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 128000,
		maxTokens: 16384,
		compat: { supportsDeveloperRole: false },
	},
	{
		id: "github-copilot/gemini-2.5-pro",
		name: "Copilot · Gemini 2.5 Pro",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "github-copilot/gemini-3-flash",
		name: "Copilot · Gemini 3 Flash",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "github-copilot/gemini-3.1-pro",
		name: "Copilot · Gemini 3.1 Pro",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "github-copilot/gpt-4.1",
		name: "Copilot · GPT 4.1",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 32768,
	},
	{
		id: "github-copilot/gpt-4o",
		name: "Copilot · GPT 4o",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		id: "github-copilot/gpt-5-mini",
		name: "Copilot · GPT 5 mini",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 262144,
		maxTokens: 32768,
	},
	{
		id: "github-copilot/gpt-5.3-codex",
		name: "Copilot · GPT 5.3 Codex",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 262144,
		maxTokens: 32768,
	},
	{
		id: "github-copilot/gpt-5.4",
		name: "Copilot · GPT 5.4",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 262144,
		maxTokens: 32768,
	},
	{
		id: "github-copilot/gpt-5.4-mini",
		name: "Copilot · GPT 5.4 mini",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 262144,
		maxTokens: 32768,
	},
	{
		id: "github-copilot/grok-code-fast-1",
		name: "Copilot · Grok Code Fast 1",
		reasoning: false,
		contextWindow: 262144,
		maxTokens: 32768,
	},
	// * OpenAI Codex
	{
		id: "openai-codex/gpt-5.1-codex-mini",
		name: "Codex · GPT 5.1 Codex mini",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 272000,
		maxTokens: 128000,
	},
	{
		id: "openai-codex/gpt-5.3-codex",
		name: "Codex · GPT 5.3 Codex",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 272000,
		maxTokens: 128000,
	},
	{
		id: "openai-codex/gpt-5.4",
		name: "Codex · GPT 5.4",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1050000,
		maxTokens: 128000,
	},
	{
		id: "openai-codex/gpt-5.4-mini",
		name: "Codex · GPT 5.4 mini",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 272000,
		maxTokens: 128000,
	},
	// * Qwen
	{
		id: "qwen/coder-model",
		name: "Qwen · Coder model",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 65536,
		compat: { supportsDeveloperRole: false, thinkingFormat: "qwen" },
	},
	{
		id: "qwen/vision-model",
		name: "Qwen · Vision model",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 262144,
		maxTokens: 32768,
		compat: { supportsDeveloperRole: false, thinkingFormat: "qwen" },
	},
];

function normalizeSmartRouterBaseUrl(value?: string | null): string {
	const raw = String(value || "").trim();
	if (!raw) return "";
  let normalized = raw.replace(/\/+$/, "");
	if (!/^https?:\/\//i.test(normalized)) normalized = `https://${normalized}`;
  if (!normalized.endsWith("/v1")) normalized = `${normalized}/v1`;
  return normalized;
}

function getSmartRouterBaseUrl(): string {
  return normalizeSmartRouterBaseUrl(process.env.SMARTROUTER_BASE_URL || process.env.SMARTROUTER_URL);
}

function getSmartRouterGatewayUrl(baseUrl = getSmartRouterBaseUrl()): string {
  return baseUrl.replace(/\/v1\/?$/i, "");
}

function getSmartRouterNoProxyHosts(baseUrl = getSmartRouterBaseUrl()): string[] {
  if (!baseUrl) return [];

  try {
    const gatewayUrl = new URL(getSmartRouterGatewayUrl(baseUrl));
    return gatewayUrl.hostname ? [gatewayUrl.hostname] : [];
  } catch {
    return [];
  }
}

function getSmartRouterApiKey(): string {
  return String(process.env[SMARTROUTER_API_KEY_ENV] || "").trim();
}

function getSmartRouterAdminToken(): string {
  return String(process.env[SMARTROUTER_ADMIN_TOKEN_ENV] || "").trim();
}

function getSmartRouterProxyEnv(baseUrl = getSmartRouterBaseUrl()): Record<string, string> {
  return getScopedTransport({
    mode: "proxy",
    noProxyHosts: getSmartRouterNoProxyHosts(baseUrl),
  }).proxyEnv;
}

function buildSmartRouterModels() {
  return SMARTROUTER_MODEL_SEEDS.map((model) => ({
    id: model.id,
    name: model.name,
    reasoning: model.reasoning ?? false,
    input: model.input ?? ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow ?? 262144,
    maxTokens: model.maxTokens ?? 32768,
    ...(model.compat ? { compat: model.compat } : {}),
  }));
}

function getResolvedApiKey(options?: SimpleStreamOptions): string | undefined {
  const direct = options?.apiKey?.trim();
  if (direct && direct.toUpperCase() !== SMARTROUTER_API_KEY_ENV) return direct;
  return getSmartRouterApiKey();
}

function patchProviderMetadata(event: any, provider: string, api: Api) {
  const patchMessage = (message: any) => {
    if (!message || typeof message !== "object") return message;
    return {
      ...message,
      provider,
      api,
    };
  };

  if (!event || typeof event !== "object") return event;
  return {
    ...event,
    ...("partial" in event ? { partial: patchMessage(event.partial) } : {}),
    ...("message" in event ? { message: patchMessage(event.message) } : {}),
    ...("error" in event ? { error: patchMessage(event.error) } : {}),
  };
}

function matchesAnyPattern(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
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

function classifySmartRouterError(error: unknown, modelId: string): ClassifiedSmartRouterError {
  const raw = extractErrorMessage(error);
  const message = raw.toLowerCase();

  const connectionPatterns = [
    /\bfetch failed\b/,
    /\beconnreset\b/,
    /\beconnrefused\b/,
    /\betimedout\b/,
    /\btimeout\b/,
    /\bterminated\b/,
    /\baborted?\b/,
    /\bsocket\b/,
    /\bconnection (?:error|failed|reset|closed|refused|terminated|timeout)\b/,
    /\bnetwork error\b/,
  ];

  if (!raw.trim()) {
    return {
      code: "INTERNAL_ERROR",
      message: "Unknown SmartRouter error.",
      actionHint: "Retry once. If the problem persists, inspect the gateway response and proxy routing.",
      retryable: true,
    };
  }

  if (message.includes(`missing ${SMARTROUTER_API_KEY_ENV.toLowerCase()}`) || message.includes("missing api key")) {
    return {
      code: "MISSING_API_KEY",
      message: `Missing ${SMARTROUTER_API_KEY_ENV}.`,
      actionHint: `Set ${SMARTROUTER_API_KEY_ENV} in your environment or .pi/${SMARTROUTER_ENV_BASENAME}.`,
      retryable: false,
    };
  }

  if (
    message.includes("401") ||
    message.includes("unauthorized") ||
    message.includes("incorrect api key") ||
    message.includes("invalid api key")
  ) {
    return {
      code: "UNAUTHORIZED",
      message: "SmartRouter rejected the API key.",
      actionHint: `Verify ${SMARTROUTER_API_KEY_ENV} and retry /smartrouter-test.`,
      retryable: false,
    };
  }

  if (message.includes("403") || message.includes("forbidden") || message.includes("access denied")) {
    return {
      code: "FORBIDDEN",
      message: "The API key is valid but lacks permission for this SmartRouter model or gateway.",
      actionHint: "Check SmartRouter account permissions and model entitlements.",
      retryable: false,
    };
  }

  if (message.includes("429") || message.includes("rate limit") || message.includes("too many requests") || message.includes("quota")) {
    return {
      code: "RATE_LIMITED",
      message: "Rate limited by SmartRouter.",
      actionHint: "Back off and retry later.",
      retryable: true,
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
      message: `The model '${modelId}' is unsupported on this SmartRouter gateway.`,
      actionHint: "Choose another configured SmartRouter model and retry.",
      retryable: false,
    };
  }

  if (matchesAnyPattern(message, connectionPatterns)) {
    return {
      code: "CONNECTION_ERROR",
      message: `SmartRouter connection failed for '${modelId}'.`,
      actionHint: "Check proxy/NO_PROXY routing, then compare /smartrouter-test with a direct streaming request.",
      retryable: true,
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: raw,
    actionHint: "Inspect the SmartRouter gateway response and proxy path, then retry if appropriate.",
    retryable: true,
  };
}

function createErrorEvent(model: Model<Api>, error: unknown) {
  const classified = classifySmartRouterError(error, model.id);
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
      provider: SMARTROUTER_PROVIDER_ID,
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
  const transportMode = getSmartRouterStreamTransportMode();

  const scopedTransport = getScopedTransport({
    mode: transportMode,
    noProxyHosts: getSmartRouterNoProxyHosts(params.baseUrl),
  });

  const innerStream = streamOpenAICompletions(modelWithBaseUrl as any, params.context, {
    ...params.options,
    apiKey: params.apiKey,
    headers: createScopedFetchHeaders({
      ...params.options?.headers,
      "User-Agent": SMARTROUTER_USER_AGENT,
    }),
    fetch: scopedTransport.fetch,
  } as any);

  for await (const event of innerStream) {
    params.stream.push(patchProviderMetadata(event, SMARTROUTER_PROVIDER_ID, SMARTROUTER_API_ID));
  }
}

function streamSmartRouter(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  let isClosed = false;

  const endStream = () => {
    if (isClosed) return;
    isClosed = true;
    stream.end();
  };

  const failStream = (error: unknown) => {
    if (isClosed) return;
    stream.push(createErrorEvent(model, error));
    endStream();
  };

  void (async () => {
    const apiKey = getResolvedApiKey(options);
    const baseUrl = getSmartRouterBaseUrl();

    if (!baseUrl) {
      failStream(new Error("SmartRouter base URL not configured."));
      return;
    }

    if (!apiKey) {
      failStream(new Error(`Missing ${SMARTROUTER_API_KEY_ENV}`));
      return;
    }

    try {
      await forwardInnerStream({
        stream,
        model,
        context,
        options,
        chosenModelId: model.id,
        apiKey,
        baseUrl,
      });
      endStream();
    } catch (error) {
      failStream(error);
    }
  })().catch(failStream);

  return stream;
}

async function fetchSmartRouterJson(path: string, token?: string): Promise<{ ok: boolean; status: number; body: any }> {
  const url = `${getSmartRouterGatewayUrl()}${path}`;
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  const text = await response.text();
  let body: any = text;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { ok: response.ok, status: response.status, body };
}

function formatSmartRouterStatusLine(label: string, result: { ok: boolean; status: number; body: any }): string {
  const suffix = typeof result.body === "string"
    ? result.body.trim().slice(0, 140)
    : Array.isArray(result.body?.data)
      ? `${result.body.data.length} models`
      : Array.isArray(result.body)
        ? `${result.body.length} entries`
        : typeof result.body === "object" && result.body
          ? JSON.stringify(result.body).slice(0, 140)
          : "";
  return `${label}: ${result.ok ? "OK" : "ERR"} (${result.status})${suffix ? ` · ${suffix}` : ""}`;
}

export default function providerSmartRouter(pi: ExtensionAPI) {
	loadSmartRouterEnvFile();
	const baseUrl = getSmartRouterBaseUrl();
	const proxyEnv = getSmartRouterProxyEnv(baseUrl);
	const proxyEnvText = formatProxyEnv(proxyEnv);
	const registeredModels = buildSmartRouterModels();
	const bundledModelIds = registeredModels.map((model) => model.id).join(", ");

	if (baseUrl) {
		pi.registerProvider(SMARTROUTER_PROVIDER_ID, {
			baseUrl,
			apiKey: SMARTROUTER_API_KEY_ENV,
			api: SMARTROUTER_API_ID,
			headers: {
				"User-Agent": SMARTROUTER_USER_AGENT,
			},
			models: registeredModels,
			streamSimple: streamSmartRouter,
		});
	} else {
		console.log(
			`[SmartRouter] Registration skipped: set SMARTROUTER_BASE_URL or SMARTROUTER_URL, or add ${SMARTROUTER_ENV_BASENAME} under ~/.pi/ or <project>/.pi/ (or extensions/)`,
		);
	}

  pi.registerCommand("smartrouter-status", {
    description: "Check SmartRouter gateway health, configured base URL, and model catalog availability",
    handler: async (_args, ctx) => {
      const baseUrl = getSmartRouterBaseUrl();
      const apiKey = getSmartRouterApiKey();
      const adminToken = getSmartRouterAdminToken();
      const transportMode = getSmartRouterStreamTransportMode();
      const lines = [
        `Provider: ${SMARTROUTER_PROVIDER_ID}`,
				baseUrl
					? `Base URL: ${baseUrl}`
					: `Base URL: not configured (set SMARTROUTER_BASE_URL or SMARTROUTER_URL)`,
        `API key env ${SMARTROUTER_API_KEY_ENV}: ${apiKey ? "set" : "missing"}`,
        `Admin token env ${SMARTROUTER_ADMIN_TOKEN_ENV}: ${adminToken ? "set" : "missing"}`,
        `Stream transport mode: ${transportMode}`,
        `Proxy env: ${proxyEnvText}`,
        `Bundled models: ${bundledModelIds}`,
      ];

			if (baseUrl) {
				try {
					const health = await fetchSmartRouterJson("/healthz");
					lines.push(formatSmartRouterStatusLine("Health", health));
				} catch (error: any) {
					lines.push(`Health: error · ${error?.message || String(error)}`);
				}
			} else {
				lines.push("Health: skipped (no base URL configured)");
			}

			if (!baseUrl) {
				lines.push("Models: skipped (no base URL configured)");
			} else if (apiKey) {
				try {
					const models = await fetchSmartRouterJson("/v1/models", apiKey);
					lines.push(formatSmartRouterStatusLine("Models", models));
				} catch (error: any) {
					lines.push(`Models: error · ${error?.message || String(error)}`);
				}
			} else {
				lines.push(`Models: skipped · set ${SMARTROUTER_API_KEY_ENV} to query /v1/models`);
			}

			if (!baseUrl) {
				lines.push("Admin accounts: skipped (no base URL configured)");
			} else if (adminToken) {
				try {
					const accounts = await fetchSmartRouterJson("/admin/accounts", adminToken);
					lines.push(formatSmartRouterStatusLine("Admin accounts", accounts));
				} catch (error: any) {
					lines.push(`Admin accounts: error · ${error?.message || String(error)}`);
				}
			} else {
				lines.push(`Admin accounts: skipped · set ${SMARTROUTER_ADMIN_TOKEN_ENV} to query /admin/accounts`);
			}

      ctx.ui.notify(lines.join("\n"), apiKey || adminToken ? "info" : "warning");
    },
  });

	if (baseUrl) {
		console.log(`[SmartRouter] Registered provider ${SMARTROUTER_PROVIDER_ID}`);
		console.log(`[SmartRouter] Base URL: ${baseUrl}`);
	} else {
		console.log(`[SmartRouter] Provider not registered (no base URL)`);
	}
	console.log(`[SmartRouter] Proxy env: ${proxyEnvText}`);
	pi.registerCommand("smartrouter-test", {
    description: "Send a live inference request via SmartRouter and show the result",
    handler: async (args, ctx) => {
      const modelId = args.trim() || "openai-codex/gpt-5.4";
      const url     = getSmartRouterBaseUrl();
      const apiKey  = getSmartRouterApiKey();

      if (!url)    { ctx.ui.notify("SmartRouter base URL not configured.", "warning"); return; }
      if (!apiKey) { ctx.ui.notify("SMARTROUTER_API_KEY not set.", "warning"); return; }

      ctx.ui.notify(`[SmartRouter] Sending test to ${modelId} …`, "info");

      try {
        const res = await fetch(`${url}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: modelId,
            stream: false,
            max_tokens: 32,
            messages: [
              { role: "system", content: "You are a helpful assistant." },
              { role: "user",   content: "Reply with exactly: INFERENCE_OK" },
            ],
          }),
        });
        const raw = await res.text();
        if (!res.ok) {
          ctx.ui.notify(`HTTP ${res.status} — ${raw.slice(0, 240)}`, "warning");
          return;
        }
        const json  = JSON.parse(raw);
        const reply = json.choices?.[0]?.message?.content ?? "(no content)";
        ctx.ui.notify(`HTTP ${res.status} · model: ${json.model ?? modelId}\nReply: ${reply}`, "info");
      } catch (err: any) {
        ctx.ui.notify(`Fetch error: ${err?.message ?? String(err)}`, "warning");
      }
    },
  });

}
