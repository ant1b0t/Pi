// [provider-smartrouter.ts] Registers SmartRouter OpenAI-compatible provider for Pi.
// Core function: Loads smartrouter.env (global .pi, cwd .pi, extension dir) then registerProvider.
// Key dependencies: @mariozechner/pi-coding-agent, node:fs/path/url/os.
// Usage: Auto via .pi/extensions/provider-smartrouter.ts or pi -e extensions/provider-smartrouter.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SMARTROUTER_PROVIDER_ID = "smartrouter";
const SMARTROUTER_API_KEY_ENV = "SMARTROUTER_API_KEY";
const SMARTROUTER_ADMIN_TOKEN_ENV = "SMARTROUTER_ADMIN_TOKEN";
const SMARTROUTER_ENV_BASENAME = "smartrouter.env";

/**
 * Parses KEY=value lines from one smartrouter.env file.
 */
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
		contextWindow: 200000,
		maxTokens: 16384,
		compat: { supportsDeveloperRole: false },
	},
	{
		id: "github-copilot/claude-opus-4.6",
		name: "Copilot · Claude Opus 4.6",
		reasoning: true,
		contextWindow: 200000,
		maxTokens: 16384,
		compat: { supportsDeveloperRole: false },
	},
	{
		id: "github-copilot/claude-sonnet-4.6",
		name: "Copilot · Claude Sonnet 4.6",
		reasoning: true,
		contextWindow: 200000,
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
		contextWindow: 262144,
		maxTokens: 32768,
	},
	{
		id: "github-copilot/gpt-5.3-codex",
		name: "Copilot · GPT 5.3 Codex",
		reasoning: true,
		contextWindow: 262144,
		maxTokens: 32768,
	},
	{
		id: "github-copilot/gpt-5.4",
		name: "Copilot · GPT 5.4",
		reasoning: true,
		contextWindow: 262144,
		maxTokens: 32768,
	},
	{
		id: "github-copilot/gpt-5.4-mini",
		name: "Copilot · GPT 5.4 mini",
		reasoning: false,
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
		contextWindow: 262144,
		maxTokens: 32768,
	},
	{
		id: "openai-codex/gpt-5.3-codex",
		name: "Codex · GPT 5.3 Codex",
		reasoning: true,
		contextWindow: 262144,
		maxTokens: 32768,
	},
	{
		id: "openai-codex/gpt-5.4",
		name: "Codex · GPT 5.4",
		reasoning: true,
		contextWindow: 262144,
		maxTokens: 32768,
	},
	{
		id: "openai-codex/gpt-5.4-mini",
		name: "Codex · GPT 5.4 mini",
		reasoning: false,
		contextWindow: 262144,
		maxTokens: 32768,
	},
	// * Qwen
	{
		id: "qwen/coder-model",
		name: "Qwen · Coder model",
		reasoning: false,
		contextWindow: 1048576,
		maxTokens: 65536,
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

function getSmartRouterApiKey(): string {
  return String(process.env[SMARTROUTER_API_KEY_ENV] || "").trim();
}

function getSmartRouterAdminToken(): string {
  return String(process.env[SMARTROUTER_ADMIN_TOKEN_ENV] || "").trim();
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

async function fetchSmartRouterJson(path: string, token?: string): Promise<{ ok: boolean; status: number; body: any }> {
  const response = await fetch(`${getSmartRouterGatewayUrl()}${path}`, {
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

	// Re-register on every runtime/session recreation. Avoid one-time global guards here:
	// Pi 0.65+ may rebuild the extension runtime on /new, /resume, /fork, and /reload.
	const baseUrl = getSmartRouterBaseUrl();

	if (baseUrl) {
		pi.registerProvider(SMARTROUTER_PROVIDER_ID, {
			baseUrl,
			apiKey: SMARTROUTER_API_KEY_ENV,
			authHeader: true,
			api: "openai-completions",
			models: buildSmartRouterModels(),
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
      const lines = [
        `Provider: ${SMARTROUTER_PROVIDER_ID}`,
				baseUrl
					? `Base URL: ${baseUrl}`
					: `Base URL: not configured (set SMARTROUTER_BASE_URL or SMARTROUTER_URL)`,
        `API key env ${SMARTROUTER_API_KEY_ENV}: ${apiKey ? "set" : "missing"}`,
        `Admin token env ${SMARTROUTER_ADMIN_TOKEN_ENV}: ${adminToken ? "set" : "missing"}`,
        `Bundled models: ${buildSmartRouterModels().map((model) => model.id).join(", ")}`,
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
	console.log(`[SmartRouter] Status command: /smartrouter-status`);
}
