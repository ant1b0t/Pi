#!/usr/bin/env bun
/**
 * Pi CLI — standalone LLM command-line tool
 *
 * Calls an OpenAI-compatible API from the terminal, no Pi agent required.
 *
 * Usage:
 *   bun src/cli.ts "Your task"
 *   bun cli "Your task"
 *   pi-cli --model deepseek-v4-flash --print "Hello"
 *
 * Flags:
 *   --model, -m <id>   Model name (default: deepseek-v4-flash)
 *   --system, -s <txt>  Custom system prompt
 *   --print, -p         Raw output only (pipe-friendly)
 *   --help, -h          Show help
 *
 * Auth (first match wins):
 *   1. OPENAI_API_KEY env var
 *   2. ~/.pi/agent/models.json → providers.opencode.apiKey
 *
 * API base URL:
 *   OPENAI_BASE_URL env var (default: https://opencode.ai/zen/go/v1)
 */

import { fetch } from "undici";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { env, argv, exit, stderr, stdout } from "node:process";

// ── Defaults ────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1";
const DEFAULT_MODEL = "deepseek-v4-flash";

// ── Auth helpers ────────────────────────────────────────────────────────

function readModelsJson(): Record<string, unknown> | null {
	try {
		const p = join(homedir(), ".pi", "agent", "models.json");
		if (!existsSync(p)) return null;
		return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function resolveApiKey(): string | undefined {
	// 1. Environment variable
	const envKey = env.OPENAI_API_KEY?.trim();
	if (envKey) return envKey;

	// 2. Fallback to models.json
	const cfg = readModelsJson();
	if (cfg) {
		const providers = cfg.providers as Record<string, unknown> | undefined;
		const opencode = providers?.opencode as Record<string, unknown> | undefined;
		if (opencode?.apiKey && typeof opencode.apiKey === "string") {
			return opencode.apiKey.trim();
		}
	}

	return undefined;
}

// ── Help ────────────────────────────────────────────────────────────────

function showHelp(exitCode = 0): never {
	const lines = [
		`Pi CLI — LLM-powered command-line assistant`,
		``,
		`Usage:`,
		`  bun src/cli.ts [options] <task>`,
		`  bun cli [options] <task>`,
		`  pi-cli [options] <task>`,
		``,
		`Options:`,
		`  --model, -m <name>  Model to use (default: ${DEFAULT_MODEL})`,
		`  --system, -s <txt>  Custom system prompt`,
		`  --print, -p         Output only the response text (pipe-friendly)`,
		`  --help, -h          Show this help`,
		``,
		`Environment:`,
		`  OPENAI_API_KEY    API key (takes precedence over config)`,
		`  OPENAI_BASE_URL   API base URL (default: ${DEFAULT_BASE_URL})`,
		``,
		`Config fallback:`,
		`  ~/.pi/agent/models.json`,
		``,
		`Examples:`,
		`  bun cli "What is the capital of France?"`,
		`  bun cli --print "Hi in one sentence"`,
		`  bun cli --model deepseek-v4-pro "Write a haiku about Go"`,
		`  bun cli --system "You are a pirate" "Say hello"`,
	];
	for (const l of lines) stdout.write(l + "\n");
	exit(exitCode);
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const args = argv.slice(2);

	// ── Parse flags ────────────────────────────────────────────────────
	let model = DEFAULT_MODEL;
	let printMode = false;
	let systemPrompt: string | null = null;
	const positional: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--help" || a === "-h") showHelp(0);
		if (a === "--model" || a === "-m") {
			model = args[++i]?.trim() || DEFAULT_MODEL;
		} else if (a === "--print" || a === "-p") {
			printMode = true;
		} else if (a === "--system" || a === "-s") {
			systemPrompt = args[++i]?.trim() || null;
		} else {
			positional.push(a);
		}
	}

	const task = positional.join(" ").trim();
	if (!task) {
		stderr.write("Error: No task provided.\n\n");
		showHelp(1);
	}

	// ── Auth ──────────────────────────────────────────────────────────
	const apiKey = resolveApiKey();
	if (!apiKey) {
		stderr.write(
			"Error: No API key found.\n" +
				"Set OPENAI_API_KEY environment variable or configure ~/.pi/agent/models.json\n",
		);
		exit(1);
	}

	// ── Messages ──────────────────────────────────────────────────────
	const messages: Array<{ role: string; content: string }> = [];
	if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
	messages.push({ role: "user", content: task });

	const baseUrl = (env.OPENAI_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
	const url = `${baseUrl}/chat/completions`;

	// ── Request ────────────────────────────────────────────────────────
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
				"User-Agent": "Pi-CLI/0.1",
			},
			body: JSON.stringify({
				model,
				messages,
				stream: false,
			}),
		});
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		stderr.write(`Error: Connection failed — ${msg}\n`);
		exit(1);
	}

	if (!response.ok) {
		const errorBody = await response.text().catch(() => "(unable to read body)");
		stderr.write(`Error: API returned ${response.status} ${response.statusText}\n`);
		if (errorBody) stderr.write(errorBody + "\n");
		exit(1);
	}

	// ── Parse ──────────────────────────────────────────────────────────
	let data: { choices?: Array<{ message?: { content?: string } }> };
	try {
		data = (await response.json()) as typeof data;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		stderr.write(`Error: Failed to parse API response — ${msg}\n`);
		exit(1);
	}

	const content = data.choices?.[0]?.message?.content?.trim();
	if (!content) {
		stderr.write("Error: Empty response from API (no content in choice)\n");
		exit(1);
	}

	// ── Output ────────────────────────────────────────────────────────
	if (printMode) {
		stdout.write(content + "\n");
	} else {
		const sep = "─".repeat(Math.min(60, process.stdout.columns || 60));
		stdout.write(`${sep} ${model} ${sep}\n\n${content}\n\n${sep}\n`);
	}
}

main().catch((err: unknown) => {
	const msg = err instanceof Error ? err.message : String(err);
	stderr.write(`Fatal: ${msg}\n`);
	exit(1);
});
