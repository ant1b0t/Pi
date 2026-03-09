/**
 * agent-runner.ts — Process spawning and session management for agent extensions
 *
 * Reusable infrastructure for any Pi extension that launches Pi subprocesses:
 *   - Shared constants (timeouts, retry config)
 *   - Session file creation and cleanup
 *   - Cross-platform process kill (SIGTERM/SIGKILL on Unix, taskkill on Windows)
 *   - Pi subprocess spawning — correct cross-platform approach via process.execPath
 *   - Tool list resolution from tags or explicit list
 *   - Extension file resolution (base-tools + base-agents)
 *   - Output format helper
 *
 * No Pi API dependency — import from any agent extension.
 *
 * === SPAWN APPROACH ===
 * Uses spawn(process.execPath, [piCli, ...args], { shell: false }).
 * Never shell:true — Node.js would join args into one shell string,
 * breaking any task containing quotes or special chars on Windows.
 *
 * === SESSION FILES ===
 * Each subagent gets a persistent .jsonl session file under:
 *   <cwd>/.pi/agent-sessions/<subdir>/agent-<id>-<timestamp>.jsonl
 * Subdir can be customised per extension (e.g. "team", "chain", "subagents").
 */

import type { ChildProcess } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	getBuiltinTools,
	resolveTagsToTools,
	toolsNeedBaseAgents,
	toolsNeedBaseTools,
} from "./agent-tags.ts";

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Basic .env parser. Loads KEY=VALUE pairs from a file.
 * Silently skips missing files or malformed lines.
 */
function loadDotEnv(cwd: string): Record<string, string> {
	const env: Record<string, string> = {};
	const filePath = path.resolve(cwd, ".env");
	if (!existsSync(filePath)) return env;

	try {
		const content = readFileSync(filePath, "utf-8");
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const idx = trimmed.indexOf("=");
			if (idx > 0) {
				const key = trimmed.slice(0, idx).trim();
				let val = trimmed.slice(idx + 1).trim();
				// Remove optional quotes
				if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
					val = val.slice(1, -1);
				}
				if (key) {
					env[key] = val;
					// Standardize Google/Gemini keys
					if (key === "GEMINI_API_KEY" && !env["GOOGLE_API_KEY"]) env["GOOGLE_API_KEY"] = val;
					if (key === "GOOGLE_API_KEY" && !env["GEMINI_API_KEY"]) env["GEMINI_API_KEY"] = val;
				}
			}
		}
	} catch {}
	return env;
}

// ── Constants ──────────────────────────────────────────────────────────

/** Wall-clock limit for agent_join / runAgent timeout. */
export const AGENT_JOIN_TIMEOUT_MS = 15 * 60 * 1000;

/** Delay between SIGTERM and SIGKILL on Unix. */
export const SIGKILL_DELAY_MS = 3000;

/** Max stderr lines to keep per agent (for error display). */
export const MAX_STDERR_LINES = 10;

/** Shared timer interval for widget updates (ms). */
export const WIDGET_UPDATE_INTERVAL_MS = 1000;

/** Poll interval while agent_join is blocking (ms). */
export const AGENT_JOIN_POLL_INTERVAL_MS = 500;

/** Delay before sending a follow-up notification after agent completes (ms).
 *  Cancelled if agent_join returns before the delay expires. */
export const AGENT_NOTIFICATION_DELAY_MS = 2500;

/** Extra retry attempts when verifying session file exists after creation. */
export const SESSION_FILE_RETRY_ATTEMPTS = 1;

/** Delay between session file existence retries (ms). */
export const SESSION_FILE_RETRY_DELAY_MS = 50;

// ── Tool Resolution ────────────────────────────────────────────────────

/** Canonicalize tool order for deterministic prompts/env and better prefix-cache hit rate. */
export function canonicalizeToolList(toolList: string[]): string[] {
	return Array.from(new Set(toolList.map((t) => t.trim()).filter(Boolean))).sort();
}

/**
 * Resolve tags to a full string[] of tool names.
 * Defaults to "Bash" tag (base read-only tools + bash).
 */
export function resolveToolsParam(tags?: string | string[]): string[] {
	if (!tags) {
		return canonicalizeToolList(resolveTagsToTools("Bash"));
	}

	if (Array.isArray(tags)) {
		// Explicit array of tools: use as-is (with cleanup/sorting)
		return canonicalizeToolList(tags);
	}

	const strTags = tags.trim();
	if (strTags) {
		// String: parse as comma-separated tags
		return canonicalizeToolList(resolveTagsToTools(strTags));
	}

	return canonicalizeToolList(resolveTagsToTools("Bash"));
}

// ── Session Management ─────────────────────────────────────────────────

/**
 * Create a project-local session JSONL file for a subagent.
 * Path: <cwd>/.pi/agent-sessions/<subdir>/agent-<id>-<timestamp>.jsonl
 *
 * Validates the path does not escape the project root (path traversal guard).
 * Creates the directory and an empty file so the subprocess sees it immediately.
 *
 * @param id      Agent ID (used in filename)
 * @param cwd     Project root directory
 * @param subdir  Subdirectory name under .pi/agent-sessions/ (default: "subagents")
 */
export function makeSessionFile(id: number, cwd: string, subdir = "subagents"): string {
	const projectRoot = path.resolve(cwd);
	const dir = path.resolve(projectRoot, ".pi", "agent-sessions", subdir);

	const relativeDir = path.relative(projectRoot, dir);
	if (relativeDir.startsWith("..") || path.isAbsolute(relativeDir)) {
		throw new Error(`Session path escapes project root: ${dir}`);
	}

	try {
		mkdirSync(dir, { recursive: true });
	} catch (err: any) {
		throw new Error(`Failed to create session directory: ${err.message}`);
	}

	const sessionFile = path.resolve(dir, `agent-${id}-${Date.now()}.jsonl`);
	const relativeFile = path.relative(projectRoot, sessionFile);
	if (relativeFile.startsWith("..") || path.isAbsolute(relativeFile)) {
		throw new Error(`Session file path escapes project root: ${sessionFile}`);
	}

	// Create empty file immediately so subprocess's existsSync check passes
	writeFileSync(sessionFile, "", "utf-8");
	return sessionFile;
}

/**
 * Delete all files in a session directory. Silently ignores errors.
 * Use during session_shutdown to clean up orphaned session files.
 */
export function cleanSessionDir(dir: string): void {
	if (!existsSync(dir)) return;
	for (const file of readdirSync(dir)) {
		if (file.endsWith(".jsonl")) {
			try { unlinkSync(path.join(dir, file)); } catch {}
		}
	}
}

/**
 * Resolve the currently running Pi CLI script path.
 * Prefers an explicit env override so child processes can inherit a stable path.
 */
export function resolvePiCliPath(): string {
	const candidate = process.env.PI_CLI_PATH || process.argv[1];
	if (!candidate || !existsSync(candidate)) {
		throw new Error("Could not resolve Pi CLI path. Set PI_CLI_PATH or launch via the pi CLI.");
	}
	return candidate;
}

// ── Process Kill ───────────────────────────────────────────────────────

/**
 * Kill a process cross-platform.
 * Windows: taskkill /T /F (kills process tree)
 * Unix: SIGTERM
 */
export function killProcess(proc: ChildProcess): void {
	try {
		if (process.platform === "win32") {
			spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
				stdio: "ignore",
				timeout: 2000,
			});
		} else {
			proc.kill("SIGTERM");
		}
	} catch {}
}

/**
 * Schedule a forced SIGKILL after SIGKILL_DELAY_MS.
 * No-op on Windows (taskkill /F already forces termination).
 * Use after killProcess() when you need to guarantee the process exits.
 */
export function scheduleForceKill(proc: ChildProcess): void {
	if (process.platform !== "win32") {
		setTimeout(() => {
			try { proc.kill("SIGKILL"); } catch {}
		}, SIGKILL_DELAY_MS);
	}
}

// ── Extension Resolution ───────────────────────────────────────────────

/**
 * Resolve which Pi extension files to load for a given tool list.
 * Always adds capability-guard.ts for sub-agent tool restriction.
 * Adds base-tools.ts if toolList contains base-tools extension tools.
 * Adds base-agents.ts if toolList contains agent orchestration tools.
 *
 * Paths are resolved relative to the calling extension file.
 *
 * @param toolList   Full tool list for the subagent
 * @param callerUrl  Pass `import.meta.url` from your extension file
 */
export function resolveExtensions(toolList: string[], callerUrl: string): string[] {
	const extBase = path.dirname(
		callerUrl.startsWith("file://") ? fileURLToPath(callerUrl) : callerUrl,
	);
	const ext = (name: string) => path.join(extBase, name);

	const extensions: string[] = [ext("capability-guard.ts")];
	if (toolsNeedBaseTools(toolList)) extensions.push(ext("base-tools.ts"));
	if (toolsNeedBaseAgents(toolList)) extensions.push(ext("base-agents.ts"));
	return extensions;
}

// ── Spawn ──────────────────────────────────────────────────────────────

export interface SpawnPiOptions {
	/** The task/prompt string passed to the subagent. */
	task: string;
	/** Absolute path to the session JSONL file (from makeSessionFile). */
	sessionFile: string;
	/** Full tool list including both builtin and extension tools. */
	toolList: string[];
	/** Extension file paths to load (from resolveExtensions). */
	extensions: string[];
	/** Optional model string, e.g. "anthropic/claude-opus-4-5". */
	model?: string;
	/** Working directory for the subprocess. */
	cwd: string;
	/** Pass true to add -c (continue existing session history). */
	isContinuation?: boolean;
	/** Optional extra system prompt appended for the sub-agent. */
	appendSystemPrompt?: string;
	/** Extra env vars merged into the subprocess environment. */
	extraEnv?: Record<string, string>;
}

/**
 * Spawn a Pi subprocess — the correct cross-platform approach.
 *
 * Runs the SAME cli.js that started this Pi instance, via Node.js directly:
 *   spawn(process.execPath, [piCli, ...args], { shell: false })
 *
 * NO shell involved → no shell escaping issues on Windows.
 * Any task string (quotes, &, %, !, etc.) passes through safely as argv.
 *
 * Returns the ChildProcess — attach stdout/stderr listeners and handle "close".
 */
export function spawnPiProcess(opts: SpawnPiOptions): ChildProcess {
	const piCli = resolvePiCliPath(); // cli.js of the currently running Pi instance
	const builtin = getBuiltinTools(opts.toolList);
	const toolsArg = builtin.length > 0 ? builtin.join(",") : "read,grep,find,ls";

	// Merge current process environment with .env file and explicit extraEnv
	const dotEnv = loadDotEnv(opts.cwd);
	const mergedEnv = {
		...process.env,
		...dotEnv,
		PI_CLI_PATH: piCli,
		...opts.extraEnv,
	};

	const args = [
		piCli,
		"--mode", "json",
		"-p",
		"--session", opts.sessionFile,
		...(opts.isContinuation ? ["-c"] : []),
		...opts.extensions.flatMap((e) => ["-e", e]),
		"--tools", toolsArg,
		"--thinking", "off",
	];
	if (opts.model) args.push("--model", opts.model);
	if (opts.appendSystemPrompt?.trim()) args.push("--append-system-prompt", opts.appendSystemPrompt);
	args.push(opts.task);

	return spawn(process.execPath, args, {
		cwd: opts.cwd,
		stdio: ["ignore", "pipe", "pipe"],
		env: mergedEnv,
		shell: false,
	});
}

// ── Output Formatting ──────────────────────────────────────────────────

export interface FormattedAgentOutput {
	text: string;
	truncated: boolean;
	originalLength: number;
}

/** Max characters for a sub-agent's full text output before truncation/artifact occurs. */
export const MAX_FULL_OUTPUT = 12000;

/**
 * Format agent output text, optionally truncating for concise mode.
 * "summary only" → first paragraph, max 1000 chars + "..."
 * "full output"  → head+tail truncation (preserves final conclusions while capping context)
 */
export function formatAgentOutputDetailed(text: string, format?: "summary only" | "full output"): FormattedAgentOutput {
	const originalLength = text.length;

	if (format === "summary only") {
		const first = text.split("\n\n")[0]?.slice(0, 1000) ?? "";
		const hasContent = first.length > 0;
		return {
			text: hasContent ? first + "..." : "",
			truncated: hasContent && originalLength > first.length,
			originalLength,
		};
	}

	if (text.length <= MAX_FULL_OUTPUT) {
		return { text, truncated: false, originalLength };
	}

	const HEAD = 8000;
	const TAIL = 3000;
	return {
		text: text.slice(0, HEAD) + "\n\n...[middle truncated]...\n\n" + text.slice(-TAIL),
		truncated: true,
		originalLength,
	};
}

export function formatAgentOutput(text: string, format?: "summary only" | "full output"): string {
	return formatAgentOutputDetailed(text, format).text;
}
