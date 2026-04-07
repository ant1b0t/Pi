import { applyPatch } from "diff";
/**
 * BaseTools — Extended tool suite for Pi
 *
 * Adds missing tools that Claude Code and OpenCode have out of the box:
 *   • web_fetch  — Fetch a URL and extract content as Markdown
 *   • glob       — Find files matching glob patterns (via ripgrep)
 *   • task       — Spawn isolated sub-agents for heavy tasks
 *   • script_run — Write and execute temporary bash/python scripts
 *   • apply_patch — Apply unified diff patches with safety validation
 *   • ask_user   — Ask the user via free-form input or fixed-choice selection
 *   • todo       — Internal task tracker that survives compaction
 *
 * Architecture:
 *   Each tool is defined in its own section with params, execute,
 *   and custom rendering. Guidance is injected into system prompt.
 *
 * Usage:
 *   pi -e extensions/base-tools.ts
 *   # or place in .pi/extensions/ for auto-discovery
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	matchesKey,
	Text,
	truncateToWidth,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { currentModelString, loadModelTiers, resolveModel, type ModelTier } from "./model-tiers.ts";
import {
	invalidArgument,
	temporaryUnavailable,
	conciseDetails,
} from "./tool-contract.ts";
import { join, resolve, isAbsolute, normalize } from "path";
import { resolvePiCliPath } from "./agent-runner.ts";

// ── Constants ────────────────────────────────────────────────────────────

const WEB_FETCH_MAX_LENGTH = 50000; // Default max characters for web_fetch
const WEB_FETCH_TIMEOUT_MS = 30000; // 30 seconds timeout for fetch
const WEB_FETCH_PREVIEW_LENGTH = 500; // Preview length in renderResult
const WEB_FETCH_MAX_RETRIES = 3;     // Retry count for transient failures
const WEB_FETCH_BASE_BACKOFF_MS = 1000;
const WEB_FETCH_RETRY_STATUS_CODES = [429, 500, 502, 503, 504];
const TASK_OUTPUT_MAX_LENGTH = 12000; // Max output length for task tool
const TASK_PREVIEW_LENGTH = 200; // Preview length for task output
const TASK_TIMEOUT_MS = 15 * 60 * 1000; // Default timeout per task worker
const TASK_BATCH_MAX_ITEMS = 8;
const TASK_BATCH_DEFAULT_PARALLEL = 3;
const TASK_BATCH_MAX_PARALLEL = 4;
const GLOB_TIMEOUT_MS = 30000; // Timeout for glob command
const SCRIPT_RUN_TIMEOUT_MS = 120000; // Default timeout for script_run
const SCRIPT_RUN_OUTPUT_MAX_LENGTH = 12000; // Max returned output from script_run

// ── Tool Guidance (injected into system prompt) ─────────────────────────

const TOOL_GUIDANCE_MAP: Record<string, string> = {
	web_fetch: "web_fetch: URL → Markdown (HTML conversion). Start with format=summary only; escalate to full output only when summary is insufficient.",
	glob: "glob: pattern → files (ripgrep, respects .gitignore)",
	task: "task: description → disposable one-shot sub-agent. Also supports tasks[] + max_parallel for bounded parallel fan-out. LIMITED USE ONLY: simple filtering, counting, bulk extraction, or cheap isolated analysis with no follow-up. Do not use for exploration, research, or multi-step delegated work. Prefer agent_spawn when available.",
	script_run: "script_run: execute a temporary bash/python script for repetitive mechanical work, bulk transforms, filtering, and structured extraction.",
	apply_patch: "apply_patch: path + unified diff → patched file. Use for complex multi-line semantic edits where 'edit' (exact match) is too brittle. Supports dry_run for validation. Hierarchy: edit (1-5 lines) → apply_patch (complex multi-line) → script_run (mechanical bulk).",
	ask_user: "ask_user: ask the user directly. Use options(string[]) for fixed choices; omit options for free-form input.",
	todo: "todo: add/done/list/clear/remove/progress → checklist (3+ steps)\nCLI: /todos",
};

const TODO_DISCIPLINE = `
## Todo discipline (IMPORTANT)
- Use todo for ANY task with 3+ steps. Add ALL steps upfront before starting.
- Mark exactly ONE task as in_progress at a time (via todo progress ids:[id]).
- Mark tasks done IMMEDIATELY when finished (todo done ids:[id]), not at the end.
- Remove tasks that are no longer relevant (todo remove ids:[id]).
- Never leave tasks in_progress or pending after work is complete — use done or remove.
- If you change direction mid-task, update the list to reflect the new plan.
- When a todo requires exploration, research, or multi-file analysis, prefer agent_spawn over task and over doing the work yourself.
`.trim();

function buildOperationalPolicy(allowed: Set<string> | null): string {
	const lines = [
		"## Operational policy",
		"- **Bundle independent lookups:** If you already know you need several files or search results, call read/grep/glob for all of them in a single response instead of one at a time.",
	];

	if (!allowed || allowed.has("bash") || allowed.has("script_run")) {
		lines.push("- **Code for mechanical work:** For repetitive changes (bulk rename, mass replace, log filtering, directory-wide transforms) prefer bash/python or script_run over many individual edit calls. Verify with diff/tests afterwards.");
	}

	lines.push("- **Sequential for dependent work:** When the next step depends on the result of the previous one, go step by step — do not batch blindly.");

	if (!allowed || allowed.has("task")) {
		lines.push("- **Bounded fan-out:** Use task(tasks[], max_parallel) for cheap independent checks; use agent_spawn when you need persistent sessions, continuation, or richer orchestration.");
	}

	if (!allowed || allowed.has("agent_spawn")) {
		lines.push("- **Delegation-first:** If agent_spawn is available, use it for non-trivial exploration, research, multi-file analysis, and parallelizable work. Keep task for disposable one-shot work.");
	}

	if (!allowed || allowed.has("edit") || allowed.has("apply_patch")) {
		lines.push("- **Edit hierarchy:** use edit for 1-5 line point changes → apply_patch for complex multi-line semantic edits → script_run for mechanical bulk transforms. Prefer dry_run=true first for apply_patch on critical files.");
	}

	lines.push("- **Semantic edits stay manual:** For logic-level or architecture changes, read context first, then use edit/write/apply_patch. Never apply a blind script to code that requires understanding.");
	return lines.join("\n");
}

function buildToolGuidance(allowed: Set<string> | null): string {
	const lines: string[] = ["## Tools"];
	const activeTools = allowed
		? Object.keys(TOOL_GUIDANCE_MAP).filter(t => allowed.has(t))
		: Object.keys(TOOL_GUIDANCE_MAP);

	for (const tool of activeTools) {
		lines.push(TOOL_GUIDANCE_MAP[tool]);
	}

	if (!allowed || allowed.has("todo")) {
		lines.push("");
		lines.push(TODO_DISCIPLINE);
	}

	lines.push("");
	lines.push(buildOperationalPolicy(allowed));

	return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════
// TYPES & SCHEMAS
// ═══════════════════════════════════════════════════════════════════════

const FormatEnum = Type.String({
	description: 'Output detail level. Allowed: "summary only" | "full output"',
});

const WebFetchParams = Type.Object({
	url: Type.String({ description: "URL (http:// or https://)" }),
	prompt: Type.Optional(Type.String({ description: "Focus question" })),
	max_length: Type.Optional(Type.Number({ description: "Max chars (default: 50000)" })),
	format: Type.Optional(FormatEnum),
});

interface WebFetchDetails {
	url: string;
	prompt?: string;
	contentLength: number;
	truncated: boolean;
	format?: "summary only" | "full output";
	httpStatus?: number;
	contentType?: string;
	error?: string;
}

const GlobParams = Type.Object({
	pattern: Type.String({ description: "Pattern (e.g. **/*.ts)" }),
	path: Type.Optional(Type.String({ description: "Directory (default: .)" })),
	limit: Type.Optional(Type.Number({ description: "Max files (default: 100)" })),
	format: Type.Optional(FormatEnum),
});

interface GlobDetails {
	pattern: string;
	path?: string;
	fileCount: number;
	truncated: boolean;
	format?: "summary only" | "full output";
	excludedCount?: number;
	fullOutputPath?: string;
	error?: string;
}

const TaskParams = Type.Object({
	description: Type.Optional(Type.String({ description: "Task description" })),
	tasks: Type.Optional(Type.Array(Type.String({ description: "Task description" }), { description: `Independent tasks to run in parallel (max ${TASK_BATCH_MAX_ITEMS})` })),
	tools: Type.Optional(Type.String({ description: "Tools (default: read,bash,grep,find,ls)" })),
	tier: Type.Optional(Type.String({ description: 'Optional model tier for worker(s): "high" | "medium" | "low"' })),
	timeout_ms: Type.Optional(Type.Number({ description: `Per-worker timeout in ms (default: ${TASK_TIMEOUT_MS})` })),
	max_output_chars: Type.Optional(Type.Number({ description: `Max returned output chars per worker (default: ${TASK_OUTPUT_MAX_LENGTH})` })),
	max_parallel: Type.Optional(Type.Number({ description: `Parallel workers for tasks[] (default: ${TASK_BATCH_DEFAULT_PARALLEL}, max: ${TASK_BATCH_MAX_PARALLEL})` })),
	format: Type.Optional(FormatEnum),
});

interface TaskWorkerDetails {
	index: number;
	description: string;
	status: "running" | "done" | "error";
	exitCode: number;
	elapsed: number;
	turnCount: number;
	toolCalls: { name: string; preview: string }[];
	outputPreview: string;
	outputText?: string;
	truncated?: boolean;
	originalLength?: number;
	error?: string;
}

interface TaskDetails {
	description?: string;
	taskCount: number;
	completedCount: number;
	failedCount: number;
	parallelCount: number;
	tools: string;
	status: "running" | "done" | "error";
	exitCode: number;
	elapsed: number;
	turnCount: number;
	toolCalls: { name: string; preview: string }[];
	outputPreview: string;
	timeoutMs?: number;
	maxOutputChars?: number;
	workerResults?: TaskWorkerDetails[];
	format?: "summary only" | "full output";
	truncated?: boolean;
	originalLength?: number;
	error?: string;
	code?: string;
	action_hint?: string;
}

const ScriptLanguageEnum = Type.String({
	description: 'Script language. Allowed: "python" | "bash"',
});

const ScriptRunParams = Type.Object({
	language: ScriptLanguageEnum,
	script: Type.String({ description: "Complete script source to write and execute" }),
	timeout_ms: Type.Optional(Type.Number({ description: `Execution timeout in ms (default: ${SCRIPT_RUN_TIMEOUT_MS})` })),
	format: Type.Optional(FormatEnum),
});

interface ScriptRunDetails {
	language: "python" | "bash";
	status: "done" | "error";
	exitCode: number;
	elapsed: number;
	scriptPath?: string;
	scriptDeleted?: boolean;
	timeoutMs: number;
	truncated: boolean;
	originalLength: number;
	stdoutLength: number;
	stderrLength: number;
	format?: "summary only" | "full output";
	error?: string;
	code?: string;
	action_hint?: string;
}

const ApplyPatchParams = Type.Object({
	path: Type.String({ description: "Path to the file (absolute or relative to cwd)" }),
	patch: Type.String({ description: "Unified diff patch string (single-file only)" }),
	dry_run: Type.Optional(Type.Boolean({ description: "If true, validate patch without writing (default: false)" })),
});

interface ApplyPatchDetails {
	path: string;
	resolvedPath: string;
	status: "done" | "error" | "dry_run_ok" | "dry_run_fail";
	applied: boolean;
	dryRun: boolean;
	diffLength: number;
	fuzzFactorUsed: number;
	originalLength?: number;
	resultLength?: number;
	retryable: boolean;
	error?: string;
	code?: string;
	action_hint?: string;
}

const AskUserParams = Type.Object({
	question: Type.String({ description: "Question" }),
	options: Type.Optional(Type.Array(Type.String({ description: "Option label" }), { description: "Options as an array of strings for fixed-choice selection. Omit options for free-form input." })),
	format: Type.Optional(FormatEnum),
});

interface AskUserDetails {
	question: string;
	options: string[];
	answer: string | null;
	status: "answered" | "cancelled" | "unavailable";
	cancelled?: boolean;
	format?: "summary only" | "full output";
}

interface TodoItem { id: number; text: string; status: "pending" | "in_progress" | "done"; }
interface TodoDetails { action: string; items: TodoItem[]; nextId: number; summary?: string; }

const TodoActionEnum = Type.String({
	description: 'Checklist action. Allowed: "add" | "done" | "list" | "clear" | "remove" | "progress"',
});

const TodoParams = Type.Object({
	action: TodoActionEnum,
	items: Type.Optional(Type.Array(Type.String(), { description: "Text (for add)" })),
	ids: Type.Optional(Type.Array(Type.Number(), { description: "IDs (for done/remove/progress)" })),
});

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

const PATH_DENY_SEGMENTS = [".git", ".ssh", ".env", "node_modules", ".gnupg", ".aws"];

function resolveAndValidatePath(rawPath: string, cwd: string): string {
	const resolved = isAbsolute(rawPath) ? normalize(rawPath) : resolve(cwd, rawPath);
	const normalized = normalize(resolved);
	const segments = normalized.replace(/\\/g, "/").split("/");
	for (const deny of PATH_DENY_SEGMENTS) {
		if (segments.includes(deny)) {
			throw invalidArgument(`Path contains denied segment '${deny}': ${normalized}`, `Remove '${deny}' from the path.`);
		}
	}
	return normalized;
}

function isPrivateOrLoopbackUrl(urlStr: string): boolean {
	try {
		const u = new URL(urlStr);
		const host = u.hostname.toLowerCase();
		if (host === "localhost" || host === "::1") return true;
		if (/^127\./.test(host)) return true;
		if (/^10\./.test(host)) return true;
		if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) return true;
		if (/^192\.168\./.test(host)) return true;
		if (/^169\.254\./.test(host)) return true;
		if (host.startsWith("fe80:") || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb")) return true;
		if (host.startsWith("fc") || host.startsWith("fd")) return true;
		return false;
	} catch { return true; }
}

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

function truncateScriptOutput(text: string, format?: "summary only" | "full output") {
	const originalLength = text.length;
	if (format === "summary only") {
		const first = text.split("\n\n")[0]?.slice(0, Math.floor(SCRIPT_RUN_OUTPUT_MAX_LENGTH / 3)) ?? "";
		return { text: first ? first + "..." : "", truncated: originalLength > first.length, originalLength };
	}
	if (text.length <= SCRIPT_RUN_OUTPUT_MAX_LENGTH) return { text, truncated: false, originalLength };
	const head = 8000; const tail = 3000;
	return { text: text.slice(0, head) + "\n\n...[middle truncated]...\n\n" + text.slice(-tail), truncated: true, originalLength };
}

function truncateTaskOutput(text: string, maxOutputChars: number, format?: "summary only" | "full output") {
	const originalLength = text.length;
	if (format === "summary only") {
		const first = text.split("\n\n")[0]?.slice(0, Math.min(1000, maxOutputChars)) ?? "";
		return { text: first ? first + "..." : "", truncated: originalLength > first.length, originalLength };
	}
	if (text.length <= maxOutputChars) return { text, truncated: false, originalLength };
	if (maxOutputChars <= 1200) return { text: text.slice(0, maxOutputChars) + "...", truncated: true, originalLength };
	const head = Math.floor(maxOutputChars * 0.7);
	const tail = Math.max(200, maxOutputChars - head - 24);
	return { text: text.slice(0, head) + "\n\n...[middle truncated]...\n\n" + text.slice(-tail), truncated: true, originalLength };
}

async function runTaskWorker(options: {
	description: string;
	tools: string;
	cwd: string;
	timeoutMs: number;
	model?: string;
	tier?: ModelTier;
	signal?: AbortSignal;
	onUpdate?: (snapshot: { turnCount: number; toolCalls: { name: string; preview: string }[]; outputPreview: string }) => void;
}): Promise<{ status: "done" | "error"; exitCode: number; elapsed: number; turnCount: number; toolCalls: { name: string; preview: string }[]; outputPreview: string; text: string; error?: string; }> {
	const start = Date.now();
	const piCli = resolvePiCliPath();
	const resolvedModel = options.model || resolveModel({ tier: options.tier, tiers: loadModelTiers(options.cwd), fallback: undefined });
	const args = [piCli, "--mode", "json", "-p", "--no-session", "--no-extensions", ...(resolvedModel ? ["--model", resolvedModel] : []), "--tools", options.tools, "--thinking", "off", options.description];

	return await new Promise((resolve) => {
		const proc = spawn(process.execPath, args, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PI_CLI_PATH: piCli },
			shell: false,
		});

		let buf = "";
		let text = "";
		let stderr = "";
		let turnCount = 0;
		const toolCalls: { name: string; preview: string }[] = [];
		let finished = false;

		const finish = (result: { status: "done" | "error"; exitCode: number; text: string; error?: string }) => {
			if (finished) return;
			finished = true;
			clearTimeout(timeoutId);
			resolve({
				status: result.status,
				exitCode: result.exitCode,
				elapsed: Date.now() - start,
				turnCount,
				toolCalls: [...toolCalls],
				outputPreview: text.slice(-TASK_PREVIEW_LENGTH) || result.error || "",
				text: result.text,
				error: result.error,
			});
		};

		const timeoutId = setTimeout(() => {
			try { proc.kill(); } catch {}
			finish({ status: "error", exitCode: -1, text, error: "Task timed out" });
		}, options.timeoutMs);

		proc.stdout?.setEncoding("utf-8");
		proc.stdout?.on("data", (chunk: string) => {
			buf += chunk;
			const lines = buf.split("\n");
			buf = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const ev = JSON.parse(line);
					if (ev.type === "message_end" && ev.message?.role === "assistant") {
						turnCount++;
						for (const p of (ev.message.content || [])) {
							if (p.type === "text") text += p.text || "";
							else if (p.type === "toolCall") toolCalls.push({ name: p.name, preview: JSON.stringify(p.arguments || {}).slice(0, 120) });
						}
						options.onUpdate?.({ turnCount, toolCalls: [...toolCalls], outputPreview: text.slice(-TASK_PREVIEW_LENGTH) });
					}
				} catch {}
			}
		});

		proc.stderr?.setEncoding("utf-8");
		proc.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});

		proc.on("close", (code) => {
			if (buf.trim()) {
				try {
					const ev = JSON.parse(buf);
					if (ev.type === "message_end" && ev.message?.role === "assistant") {
						turnCount++;
						for (const p of (ev.message.content || [])) {
							if (p.type === "text") text += p.text || "";
							else if (p.type === "toolCall") toolCalls.push({ name: p.name, preview: JSON.stringify(p.arguments || {}).slice(0, 120) });
						}
					}
				} catch {}
			}
			const normalizedText = text || stderr.trim();
			finish({ status: code === 0 ? "done" : "error", exitCode: code ?? -1, text: normalizedText, error: code === 0 ? undefined : (stderr.trim() || "Task failed") });
		});

		proc.on("error", (err) => finish({ status: "error", exitCode: -1, text, error: err.message }));
		options.signal?.addEventListener("abort", () => {
			try { proc.kill(); } catch {}
			finish({ status: "error", exitCode: -1, text, error: "Task cancelled by user" });
		}, { once: true });
	});
}

function htmlToMarkdown(html: string): string {
	let text = html;
	text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
	text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
	text = text.replace(/<svg[\s\S]*?<\/svg>/gi, "");
	text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "");
	text = text.replace(/<footer[\s\S]*?<\/footer>/gi, "");
	text = text.replace(/<header[\s\S]*?<\/header>/gi, "");
	text = text.replace(/<!--[\s\S]*?-->/g, "");
	text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
	text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
	text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
	text = text.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
	text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
	text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
	text = text.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n");
	text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");
	text = text.replace(/<\/?[ou]l[^>]*>/gi, "\n");
	text = text.replace(/<br\s*\/?>/gi, "\n");
	text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n");
	text = text.replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, "\n$1\n");
	text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, "\n> $1\n");
	text = text.replace(/<[^>]+>/g, "");
	text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
	text = text.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ");
	return text.split("\n").map(l => l.trim()).join("\n").trim();
}

function buildConciseGlobResponse(files: string[], maxFiles: number, truncated: boolean): string {
	const byDir: Record<string, number> = {};
	files.forEach(f => {
		const dir = f.split(/[\/\\]/)[0] || ".";
		byDir[dir] = (byDir[dir] || 0) + 1;
	});
	const top10 = files.slice(0, 10).join("\n");
	return `Found ${files.length} files\nBy dir: ${JSON.stringify(byDir)}\nTop ${Math.min(10, files.length)}:\n${top10}${truncated ? `\n...and ${files.length - maxFiles} more` : ""}`;
}

const IS_WINDOWS = process.platform === "win32";

function getRgCandidates(): string[] {
	const candidates: string[] = [];
	// Pi bundles rg next to its own binary
	const piCliPath = process.env.PI_CLI_PATH || process.argv[1];
	const piDir = piCliPath ? join(piCliPath, "..") : null;
	if (piDir) candidates.push(join(piDir, IS_WINDOWS ? "rg.exe" : "rg"));
	// Pi agent bin dir (common install location)
	const home = process.env.HOME || process.env.USERPROFILE || "";
	candidates.push(join(home, ".pi", "agent", "bin", IS_WINDOWS ? "rg.exe" : "rg"));
	// Plain name (relies on PATH)
	candidates.push(IS_WINDOWS ? "rg.exe" : "rg");
	return candidates;
}

async function runRipgrep(pattern: string, searchPath: string, cwd: string, timeout: number): Promise<string[]> {
	const candidates = getRgCandidates();
	const rgBin = candidates.find(c => c === (IS_WINDOWS ? "rg.exe" : "rg") || existsSync(c)) ?? (IS_WINDOWS ? "rg.exe" : "rg");

	const rgArgs = ["--files", "--glob", pattern, "--color=never", searchPath];
	const output = await new Promise<string>((resolve, reject) => {
		let settled = false;
		const proc = spawn(rgBin, rgArgs, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env },
			shell: false,
		});
		let buf = "";
		let stderr = "";
		proc.stdout!.on("data", c => { buf += c; });
		proc.stderr!.on("data", c => { stderr += c; });
		const finishReject = (err: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			reject(err);
		};
		const finishResolve = (text: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			resolve(text);
		};
		proc.on("error", err => {
			if ((err as any).code === "ENOENT") {
				finishReject(new Error(`ripgrep not found (tried: ${rgBin}).`));
			} else {
				finishReject(err instanceof Error ? err : new Error(String(err)));
			}
		});
		proc.on("close", code => {
			if (code === 0 || code === 1) finishResolve(buf);
			else finishReject(new Error(`rg exited with code ${code}: ${stderr.trim()}`));
		});
		const timeoutId = setTimeout(() => {
			try { proc.kill(); } catch {}
			finishReject(new Error("Timeout"));
		}, timeout);
	});
	return output.trim().split("\n").filter(f => f.trim()).sort();
}

// ═══════════════════════════════════════════════════════════════════════
// EXTENSION
// ═══════════════════════════════════════════════════════════════════════

export default function baseTools(pi: ExtensionAPI) {
	// Re-register on every runtime/session recreation. Avoid one-time global guards here:
	// Pi 0.65+ may rebuild the extension runtime on /new, /resume, /fork, and /reload.
	const rawTools = process.env.PI_AGENT_ALLOWED_TOOLS;
	const allowedTools = rawTools ? new Set(rawTools.split(",").map(t => t.trim()).filter(Boolean)) : null;

	function isAllowed(name: string): boolean {
		if (!allowedTools) return true;
		return allowedTools.has(name);
	}

	let todos: TodoItem[] = [];
	let todoNextId = 1;

	const reconstructTodoState = (ctx: ExtensionContext) => {
		todos = []; todoNextId = 1;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo") {
				const details = entry.message.details as TodoDetails | undefined;
				if (details) {
					todos = (details.items ?? []).map((t: any) => ({
						id: t.id, text: t.text, status: t.status ?? (t.done ? "done" : "pending"),
					}));
					todoNextId = details.nextId;
				}
			}
		}
		refreshTodoUI(ctx);
	};

	const refreshTodoUI = (ctx: ExtensionContext) => {
		const total = todos.length;
		const pending = todos.filter(t => t.status !== "done");
		if (total === 0 || pending.length === 0) {
			ctx.ui.setWidget("todo-progress", undefined);
			return;
		}
		ctx.ui.setWidget("todo-progress", (_tui, theme) => {
			return {
				render(width: number) {
					const dn2 = todos.filter(t => t.status === "done").length;
					const barWidth = Math.min(15, width - 40);
					const filled = total > 0 ? Math.round((dn2 / total) * barWidth) : 0;
					const bar = theme.fg("success", "█".repeat(filled)) + theme.fg("dim", "░".repeat(barWidth - filled));
					const cur = todos.find(t => t.status === "in_progress") ?? todos.find(t => t.status === "pending");
					const curLabel = cur
						? (cur.status === "in_progress"
							? theme.fg("accent", `▶ #${cur.id} ${cur.text}`)
							: theme.fg("muted", `→ #${cur.id} ${cur.text}`))
						: theme.fg("success", "All done!");
					const line = theme.fg("dim", " TODO [") + bar + theme.fg("dim", "] ") +
						theme.fg("warning", `${dn2}/${total} `) + curLabel;
					return [truncateToWidth(line, width - 2)];
				},
				invalidate() {}
			};
		}, { placement: "belowEditor" });
	};

	pi.on("before_agent_start", async (event) => ({ systemPrompt: event.systemPrompt + "\n\n" + buildToolGuidance(allowedTools) }));
	pi.on("session_start", async (_e, ctx) => { reconstructTodoState(ctx); ctx.ui.notify("BaseTools (Extended) Loaded", "info"); });
	pi.on("session_switch", async (_e, ctx) => reconstructTodoState(ctx));
	pi.on("session_fork", async (_e, ctx) => reconstructTodoState(ctx));
	pi.on("session_tree", async (_e, ctx) => reconstructTodoState(ctx));
	pi.on("agent_end", async (_e, ctx) => {
		const stale = todos.filter(t => t.status === "in_progress");
		if (stale.length > 0) {
			for (const t of stale) t.status = "pending";
			refreshTodoUI(ctx);
			ctx.ui.notify(`⚠ ${stale.length} task(s) left in_progress — reset to pending`, "warning");
		}
	});

	// ── web_fetch ──
	if (isAllowed("web_fetch")) pi.registerTool({
		name: "web_fetch", label: "WebFetch", description: "Fetch URL as Markdown.", parameters: WebFetchParams,
		async execute(_id, params, signal) {
			const { url, prompt, max_length, format } = params;
			const maxLen = max_length ?? WEB_FETCH_MAX_LENGTH;
			const concise = format === "summary only";
			const effectiveMax = concise ? Math.min(maxLen, 5000) : maxLen;
			if (!/^https?:\/\//i.test(url)) return invalidArgument("Invalid URL protocol.", "Retry with a valid URL").toToolResult();
			if (isPrivateOrLoopbackUrl(url)) return invalidArgument("Fetching private addresses is not allowed.", "Retry with a public URL").toToolResult();
			let response: Response | undefined; let lastError: Error | undefined;
			for (let attempt = 0; attempt < WEB_FETCH_MAX_RETRIES; attempt++) {
				const ctrl = new AbortController();
				if (signal) signal.addEventListener("abort", () => ctrl.abort());
				const timer = setTimeout(() => ctrl.abort(), WEB_FETCH_TIMEOUT_MS);
				try {
					response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; Pi/1.0)" }, signal: ctrl.signal });
					clearTimeout(timer);
					if (!response.ok && WEB_FETCH_RETRY_STATUS_CODES.includes(response.status) && attempt < WEB_FETCH_MAX_RETRIES - 1) {
						await delay(WEB_FETCH_BASE_BACKOFF_MS * Math.pow(2, attempt)); continue;
					}
					break;
				} catch (err) {
					clearTimeout(timer); lastError = err instanceof Error ? err : new Error(String(err));
					if (attempt < WEB_FETCH_MAX_RETRIES - 1) { await delay(WEB_FETCH_BASE_BACKOFF_MS * Math.pow(2, attempt)); continue; }
					response = undefined;
				}
			}
			if (!response) return temporaryUnavailable(lastError?.message ?? "Failed to fetch URL", "Retry later").toToolResult();
			if (!response.ok) return invalidArgument(`HTTP ${response.status}`, "Check the URL").toToolResult();
			const contentType = response.headers.get("content-type") || "";
			let content = await response.text();
			if (contentType.includes("html")) content = htmlToMarkdown(content);
			const truncated = content.length > effectiveMax;
			if (concise) content = content.split("\n\n")[0]?.slice(0, effectiveMax) + "...";
			else if (truncated) content = content.slice(0, effectiveMax) + "...";
			if (prompt) content = `> Question: ${prompt}\n\n${content}`;
			return {
				content: [{ type: "text", text: content }],
				details: conciseDetails(`Fetched ${url}`, { url, prompt, contentLength: content.length, contentType, truncated, format } as WebFetchDetails),
			};
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", "web_fetch ") + theme.fg("accent", args.url), 0, 0); },
		renderResult(result, { expanded }, theme) {
			const d = result.details as WebFetchDetails;
			const modeIcon = d?.format === "summary only" ? "📦" : "📄";
			let text = theme.fg("success", "✓ ") + theme.fg("muted", `${modeIcon} ${d?.contentLength} chars`);
			if (expanded && result.content[0]?.type === "text") text += "\n" + theme.fg("dim", result.content[0].text.slice(0, WEB_FETCH_PREVIEW_LENGTH) + "...");
			return new Text(text, 0, 0);
		}
	});

	// ── glob ──
	if (isAllowed("glob")) pi.registerTool({
		name: "glob", label: "Glob", description: "Find files by pattern (ripgrep).", parameters: GlobParams,
		async execute(_id, params, _s, _u, ctx) {
			const { pattern, path: searchPath, limit, format } = params;
			const maxFiles = limit ?? 100;
			const isConcise = format === "summary only";
			let files: string[];
			try {
				files = await runRipgrep(pattern, searchPath || ".", ctx.cwd, GLOB_TIMEOUT_MS);
			} catch (err: any) {
				return { content: [{ type: "text", text: `glob error: ${err.message}` }], details: conciseDetails(`Failed to search`, { pattern, error: err.message } as any) };
			}
			const truncated = files.length > maxFiles;
			if (isConcise) {
				return { content: [{ type: "text", text: buildConciseGlobResponse(files, maxFiles, truncated) }], details: conciseDetails(`Found ${files.length} files`, { pattern, fileCount: files.length, truncated, format: "summary only" } as any) };
			}
			return { content: [{ type: "text", text: files.slice(0, maxFiles).join("\n") }], details: conciseDetails(`Found ${files.length} files`, { pattern, fileCount: files.length, truncated, format: "full output" } as any) };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", "glob ") + theme.fg("accent", args.pattern), 0, 0); },
		renderResult(res, { expanded }, theme) {
			const d = res.details as GlobDetails;
			const modeIcon = d?.format === "summary only" ? "📦" : "📄";
			let text = theme.fg("success", `${modeIcon} ${d?.fileCount} files`);
			if (expanded && res.content[0]?.type === "text") text += "\n" + theme.fg("dim", res.content[0].text.slice(0, 500));
			return new Text(text, 0, 0);
		}
	});

	// ── task ──
	if (isAllowed("task")) pi.registerTool({
		name: "task", label: "Task", description: "Spawn a disposable one-shot sub-agent process for cheap isolated work. Also supports bounded fan-out via tasks[] + max_parallel. Prefer agent_spawn for non-trivial delegation, continuation, tier routing, or parallel branches.", parameters: TaskParams,
		async execute(_id, params, signal, onUpdate, ctx) {
			const description = params.description?.trim() || "";
			const tasks = (params.tasks || []).map((task) => task.trim()).filter(Boolean);
			if ((description ? 1 : 0) + (tasks.length > 0 ? 1 : 0) !== 1) {
				return invalidArgument("Provide either description or tasks[]", "Retry with one task or a bounded task list, but not both").toToolResult();
			}
			if (tasks.length > TASK_BATCH_MAX_ITEMS) {
				return invalidArgument(`tasks[] exceeds limit (${TASK_BATCH_MAX_ITEMS})`, `Retry with at most ${TASK_BATCH_MAX_ITEMS} independent tasks`).toToolResult();
			}

			const timeoutMs = Math.floor(params.timeout_ms ?? TASK_TIMEOUT_MS);
			if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
				return invalidArgument("timeout_ms must be at least 1000", "Retry with a larger timeout").toToolResult();
			}
			const maxOutputChars = Math.floor(params.max_output_chars ?? TASK_OUTPUT_MAX_LENGTH);
			if (!Number.isFinite(maxOutputChars) || maxOutputChars < 500) {
				return invalidArgument("max_output_chars must be at least 500", "Retry with a larger output cap").toToolResult();
			}

			const descriptions = tasks.length > 0 ? tasks : [description];
			const parallelCount = Math.min(Math.max(1, Math.floor(params.max_parallel ?? TASK_BATCH_DEFAULT_PARALLEL)), TASK_BATCH_MAX_PARALLEL, descriptions.length);
			const tools = params.tools || "read,bash,grep,find,ls";
			const rawTier = typeof (params as any).tier === "string" ? (params as any).tier.trim().toLowerCase() : "";
			const taskTier = rawTier === "high" || rawTier === "medium" || rawTier === "low"
				? rawTier as ModelTier
				: undefined;
			const parentModel = currentModelString(ctx.model);
			const details: TaskDetails = {
				description: description || undefined,
				taskCount: descriptions.length,
				completedCount: 0,
				failedCount: 0,
				parallelCount,
				tools,
				status: "running",
				exitCode: -1,
				elapsed: 0,
				turnCount: 0,
				toolCalls: [],
				outputPreview: descriptions.length > 1 ? `0/${descriptions.length} done` : "(running…)",
				timeoutMs,
				maxOutputChars,
				format: params.format,
				workerResults: descriptions.map((taskDescription, index) => ({
					index,
					description: taskDescription,
					status: "running",
					exitCode: -1,
					elapsed: 0,
					turnCount: 0,
					toolCalls: [],
					outputPreview: "",
				})),
			};
			const start = Date.now();
			const emit = () => onUpdate?.({ content: [{ type: "text", text: details.outputPreview || "(running…)" }], details: { ...details, workerResults: details.workerResults?.map((worker) => ({ ...worker })) } });
			const timer = setInterval(() => {
				details.elapsed = Date.now() - start;
				for (const worker of details.workerResults || []) {
					if (worker.status === "running") worker.elapsed = Date.now() - start;
				}
				emit();
			}, 1000);

			const buildBatchPreview = () => {
				const lines = [`${details.completedCount}/${details.taskCount} done${details.failedCount ? ` · ${details.failedCount} failed` : ""}`];
				for (const worker of (details.workerResults || []).slice(0, 3)) {
					lines.push(`#${worker.index + 1} ${worker.status} · ${truncateToWidth(worker.description, 50)}`);
				}
				return lines.join("\n");
			};

			try {
				let nextIndex = 0;
				const runWorker = async () => {
					while (true) {
						if (signal?.aborted) return;
						const index = nextIndex++;
						if (index >= descriptions.length) return;
						const worker = details.workerResults![index];
						const result = await runTaskWorker({
							description: descriptions[index],
							tools,
							cwd: ctx.cwd,
							timeoutMs,
							model: parentModel,
							tier: taskTier,
							signal,
							onUpdate: (snapshot) => {
								worker.turnCount = snapshot.turnCount;
								worker.toolCalls = snapshot.toolCalls;
								worker.outputPreview = snapshot.outputPreview;
								details.turnCount = (details.workerResults || []).reduce((sum, item) => sum + item.turnCount, 0);
								details.toolCalls = (details.workerResults || []).flatMap((item) => item.toolCalls).slice(-30);
								details.outputPreview = descriptions.length > 1 ? buildBatchPreview() : (snapshot.outputPreview || "(running…)");
								emit();
							},
						});

						worker.status = result.status;
						worker.exitCode = result.exitCode;
						worker.elapsed = result.elapsed;
						worker.turnCount = result.turnCount;
						worker.toolCalls = result.toolCalls;
						worker.outputPreview = result.outputPreview;
						worker.outputText = result.text;
						worker.error = result.error;
						const formatted = truncateTaskOutput(result.text || (result.error || ""), maxOutputChars, params.format);
						worker.truncated = formatted.truncated;
						worker.originalLength = formatted.originalLength;
						details.completedCount++;
						if (result.status === "error") details.failedCount++;
						details.turnCount = (details.workerResults || []).reduce((sum, item) => sum + item.turnCount, 0);
						details.toolCalls = (details.workerResults || []).flatMap((item) => item.toolCalls).slice(-30);
						details.outputPreview = descriptions.length > 1 ? buildBatchPreview() : (result.outputPreview || result.error || "(done)");
						emit();
					}
				};

				await Promise.all(Array.from({ length: parallelCount }, () => runWorker()));
			} catch (err: any) {
				clearInterval(timer);
				details.status = "error";
				details.elapsed = Date.now() - start;
				return { content: [{ type: "text", text: `Error: ${err.message}` }], details: conciseDetails(`Task failed`, { ...details, error: err.message }), isError: true };
			} finally {
				clearInterval(timer);
			}

			details.elapsed = Date.now() - start;
			details.status = details.failedCount > 0 ? "error" : "done";
			details.exitCode = details.failedCount > 0 ? 1 : 0;
			details.truncated = (details.workerResults || []).some((worker) => worker.truncated === true);
			details.originalLength = (details.workerResults || []).reduce((sum, worker) => sum + (worker.originalLength || 0), 0);

			const rendered = (details.workerResults || []).map((worker) => {
				const source = worker.status === "error"
					? [worker.error ? `Error: ${worker.error}` : "", worker.outputText ? `Partial output:\n${worker.outputText}` : ""].filter(Boolean).join("\n\n")
					: (worker.outputText || worker.outputPreview || "(task produced no output)");
				const formatted = truncateTaskOutput(source, maxOutputChars, params.format);
				return descriptions.length === 1 ? formatted.text : `#${worker.index + 1} · ${worker.description}\n${formatted.text}`;
			});

			return { content: [{ type: "text", text: rendered.join("\n\n") }], details: conciseDetails(`Task ${details.status}`, details), isError: details.status === "error" };
		},
		renderCall(args, theme) {
			const preview = Array.isArray((args as any).tasks) && (args as any).tasks.length > 0 ? `${(args as any).tasks.length} tasks` : (((args as any).description || "").slice(0, 50));
			return new Text(theme.fg("toolTitle", "task ") + theme.fg("dim", preview), 0, 0);
		},
		renderResult(res, _o, theme) {
			const d = res.details as TaskDetails;
			const modeIcon = d?.format === "summary only" ? "📦" : "📄";
			const countText = d?.taskCount && d.taskCount > 1 ? ` · ${d.completedCount}/${d.taskCount}` : "";
			return new Text((d?.status === "done" ? theme.fg("success", "✓ ") : theme.fg("error", "✗ ")) + theme.fg("toolTitle", "task ") + theme.fg("dim", `${modeIcon} ${Math.round(d?.elapsed/1000)}s${countText}`), 0, 0);
		}
	});

	// ── script_run ──
	if (isAllowed("script_run")) pi.registerTool({
		name: "script_run", label: "ScriptRun", description: "Execute a temporary script.", parameters: ScriptRunParams,
		async execute(_id, params, signal) {
			const timeoutMs = params.timeout_ms ?? SCRIPT_RUN_TIMEOUT_MS;
			const tempDir = mkdtempSync(join(tmpdir(), "pi-script-run-"));
			const ext = params.language === "python" ? ".py" : ".sh";
			const scriptPath = join(tempDir, `script${ext}`);
			writeFileSync(scriptPath, params.script, "utf-8");
			const candidates = params.language === "python" ? ["python", "python3"] : ["bash"];
			const start = Date.now();
			let finalStdout = "", finalStderr = "", finalExitCode = -1;
			try {
				for (const cmd of candidates) {
					try {
						await new Promise<void>((resolve, reject) => {
							const proc = spawn(cmd, [scriptPath], { stdio: ["ignore", "pipe", "pipe"], shell: false });
							const timeoutId = setTimeout(() => { proc.kill(); reject(new Error("Timeout")); }, timeoutMs);
							proc.stdout?.on("data", c => finalStdout += c);
							proc.stderr?.on("data", c => finalStderr += c);
							proc.on("close", code => { clearTimeout(timeoutId); finalExitCode = code ?? -1; resolve(); });
							proc.on("error", reject);
							if (signal) signal.addEventListener("abort", () => proc.kill());
						});
						break;
					} catch (err: any) { if (err.code !== "ENOENT") throw err; }
				}
				const combined = [finalStdout.trim(), finalStderr.trim() ? `[stderr]\n${finalStderr.trim()}` : ""].filter(Boolean).join("\n\n") || "(no output)";
				const formatted = truncateScriptOutput(combined, params.format);
				const details: ScriptRunDetails = { language: params.language as any, status: finalExitCode === 0 ? "done" : "error", exitCode: finalExitCode, elapsed: Date.now() - start, scriptPath, scriptDeleted: true, timeoutMs, truncated: formatted.truncated, originalLength: formatted.originalLength, stdoutLength: finalStdout.length, stderrLength: finalStderr.length, format: params.format };
				return { content: [{ type: "text", text: formatted.text }], details: conciseDetails(`script_run ${details.status}`, details), isError: finalExitCode !== 0 };
			} finally { try { rmSync(tempDir, { recursive: true, force: true }); } catch {} }
		},
		renderCall(a, theme) { return new Text(theme.fg("toolTitle", "script_run ") + theme.fg("accent", a.language), 0, 0); },
		renderResult(r, _o, theme) {
			const d = r.details as ScriptRunDetails;
			const icon = d?.status === "done" ? theme.fg("success", "✓ ") : theme.fg("error", "✗ ");
			return new Text(icon + theme.fg("toolTitle", "script_run ") + theme.fg("dim", `${d?.language} ${Math.round((d?.elapsed ?? 0)/1000)}s`), 0, 0);
		}
	});

	// ── apply_patch ──
	if (isAllowed("apply_patch")) pi.registerTool({
		name: "apply_patch", label: "Apply Patch", description: "Apply a Unified Diff patch.", parameters: ApplyPatchParams,
		async execute(_id, params, _s, _u, ctx) {
			let resolvedPath = resolveAndValidatePath(params.path, ctx.cwd);
			let src = readFileSync(resolvedPath, "utf-8");
			let result = applyPatch(src, params.patch, { fuzzFactor: 0 });
			let fuzz = 0;
			if (result === false) { result = applyPatch(src, params.patch, { fuzzFactor: 1 }); fuzz = 1; }
			if (result === false) return { content: [{ type: "text", text: "Patch rejected." }], details: conciseDetails("Patch rejected", { path: params.path, status: "error" } as any), isError: true };
			if (params.dry_run) return { content: [{ type: "text", text: "Dry run OK" }], details: conciseDetails("Dry run OK", { path: params.path, status: "dry_run_ok" } as any) };
			writeFileSync(resolvedPath, result as string, "utf-8");
			return { content: [{ type: "text", text: "Patch applied." }], details: conciseDetails("Patch applied", { path: params.path, status: "done", fuzzFactorUsed: fuzz } as any) };
		},
		renderCall(a, theme) { return new Text(theme.fg("toolTitle", "apply_patch ") + theme.fg("accent", (a.dry_run ? "validate " : "") + a.path), 0, 0); },
		renderResult(r, _o, theme) {
			const d = r.details as any;
			const icon = d?.status === "done" || d?.status === "dry_run_ok" ? theme.fg("success", "✓ ") : theme.fg("error", "✗ ");
			return new Text(icon + theme.fg("toolTitle", "apply_patch ") + theme.fg("dim", d?.path), 0, 0);
		}
	});

	// ── ask_user ──
	if (isAllowed("ask_user")) pi.registerTool({
		name: "ask_user", label: "Ask User", description: "Ask the user.", parameters: AskUserParams,
		async execute(_id, params, _s, _u, ctx) {
			if (!ctx.hasUI) return { content: [{ type: "text", text: "UI unavailable." }], details: conciseDetails("UI unavailable", { status: "unavailable" } as any) };
			const ans = (params.options && params.options.length > 0) ? await ctx.ui.select(params.question, params.options) : await ctx.ui.input(params.question);
			const cancelled = ans === null || ans === undefined;
			return { content: [{ type: "text", text: ans || "Cancelled" }], details: conciseDetails(cancelled ? "Cancelled" : "Answered", { question: params.question, answer: ans, status: cancelled ? "cancelled" : "answered" } as any) };
		},
		renderCall(a, theme) { return new Text(theme.fg("toolTitle", "ask_user ") + theme.fg("muted", a.question), 0, 0); },
		renderResult(r, _o, theme) { const d = r.details as any; return new Text(theme.fg(d?.status === "cancelled" ? "warning" : "success", d?.status === "cancelled" ? "⚠ Cancelled" : `✓ ${d?.answer}`), 0, 0); }
	});

	// ── todo ──
	if (isAllowed("todo")) pi.registerTool({
		name: "todo", label: "Todo", description: "Checklist.", parameters: TodoParams,
		async execute(_id, params, _s, _u, ctx) {
			if (params.action === "add" && params.items) {
				params.items.forEach(t => todos.push({ id: todoNextId++, text: t, status: "pending" }));
			} else if (params.action === "progress" && params.ids) {
				todos.forEach(t => { if (params.ids!.includes(t.id)) t.status = "in_progress"; else if (t.status === "in_progress") t.status = "pending"; });
			} else if (params.action === "done" && params.ids) {
				todos.forEach(t => { if (params.ids!.includes(t.id)) t.status = "done"; });
			} else if (params.action === "remove" && params.ids) {
				todos = todos.filter(t => !params.ids!.includes(t.id));
			} else if (params.action === "clear") {
				todos = []; todoNextId = 1;
			}
			const summary = `Todo: ${todos.filter(t => t.status === "done").length}/${todos.length} done.`;
			refreshTodoUI(ctx);
			return { content: [{ type: "text", text: summary }], details: conciseDetails(summary, { action: params.action, items: [...todos], nextId: todoNextId } as any) };
		},
		renderCall(a, theme) { return new Text(theme.fg("toolTitle", "todo ") + theme.fg("muted", a.action), 0, 0); },
		renderResult(r, { expanded }, theme) {
			const d = r.details as any;
			if (expanded) {
				let t = theme.fg("accent", "Todos:");
				(d?.items ?? []).forEach(i => {
					const icon = i.status === "done" ? "✓" : i.status === "in_progress" ? "▶" : "○";
					t += `\n${icon} #${i.id} ${i.text}`;
				});
				return new Text(t, 0, 0);
			}
			return new Text(theme.fg("success", `✓ todo ${d?.action}`), 0, 0);
		}
	});

	pi.registerCommand("todos", { description: "Show todos", handler: async (_a, ctx) => {
		if (!ctx.hasUI) return;
		await ctx.ui.custom<void>((_t, theme, _k, done) => ({
			handleInput(d) { if (matchesKey(d, "escape")) done(); },
			render(w) {
				const lines = ["", theme.fg("accent", "─".repeat(3) + " Todos " + "─".repeat(w - 10)), ""];
				todos.forEach(t => {
					const icon = t.status === "done" ? "✓" : t.status === "in_progress" ? "▶" : "○";
					lines.push("  " + theme.fg("text", `${icon} #${t.id} ${t.text}`));
				});
				lines.push("", theme.fg("dim", "  Esc to close"), ""); return lines;
			}, invalidate() {}
		}));
	}});
}
