/**
 * base-tools — WebFetch, Todo, AskUser, Glob
 *
 * Adds:
 *   • web_fetch  — URL fetching with HTML→Markdown conversion
 *   • todo       — task list with disciplined in-progress workflow + UI widget
 *   • ask_user   — interactive dialog with explicit status contract
 *   • glob       — bounded file discovery via glob patterns
 *
 * Optional built-in tools like grep/find/ls should be enabled explicitly.
 *
 * Usage: pi -e extensions/base-tools.ts
 *        pi --tools read,bash,edit,write,grep,find,ls -e extensions/base-tools.ts
 *
 * Optional runtime gating:
 *   BASE_TOOLS_ALLOWED=web_fetch,todo,ask_user,glob
 *   BASE_TOOLS_DISABLED=glob
 */

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DynamicBorder, formatSize, truncateHead } from "@mariozechner/pi-coding-agent";
import { Container, Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { conciseDetails, invalidArgument, notFound, rateLimited, temporaryUnavailable, unauthorized } from "./lib/tool-contract.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const TODO_TITLE_PADDING = 10;
const WEB_FETCH_MAX_RETRIES = 3;
const WEB_FETCH_BASE_BACKOFF_MS = 1000;
const WEB_FETCH_MAX_BACKOFF_MS = 10000;
const WEB_FETCH_RETRY_STATUS_CODES = [429, 500, 502, 503, 504];

const BASE_TOOL_NAMES = ["web_fetch", "todo", "ask_user", "glob"] as const;
type BaseToolName = (typeof BASE_TOOL_NAMES)[number];

const GLOB_DEFAULT_LIMIT = 200;
const GLOB_MAX_LIMIT = 2000;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function parseCsv(value?: string): string[] {
	return value
		?.split(",")
		.map((v) => v.trim())
		.filter(Boolean) ?? [];
}

function resolveEnabledBaseTools(): Set<BaseToolName> {
	const allowedFromEnv = parseCsv(process.env.BASE_TOOLS_ALLOWED);
	const disabledFromEnv = new Set(parseCsv(process.env.BASE_TOOLS_DISABLED));

	const enabled: BaseToolName[] = allowedFromEnv.length > 0
		? allowedFromEnv.filter((tool): tool is BaseToolName => BASE_TOOL_NAMES.includes(tool as BaseToolName))
		: [...BASE_TOOL_NAMES];

	return new Set(enabled.filter((tool) => !disabledFromEnv.has(tool)));
}

/** Decode all HTML entities including numeric and named */
function decodeHtmlEntities(text: string): string {
	const namedEntities: Record<string, string> = {
		amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
		nbsp: " ", copy: "©", reg: "®", trade: "™",
		mdash: "—", ndash: "–", hellip: "…", laquo: "«", raquo: "»",
		ldquo: '"', rdquo: '"', lsquo: "'", rsquo: "'",
		bull: "•", middot: "·", sect: "§", para: "¶",
	};

	return text
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
		.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name) => namedEntities[name] ?? match);
}

/** Примитивный HTML → Markdown конвертер без внешних зависимостей */
function htmlToMarkdown(html: string): string {
	const decoded = decodeHtmlEntities(html);

	return decoded
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
		.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
		.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
		.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n")
		.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n")
		.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n")
		.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
		.replace(/<img[^>]*src=["']([^"']*)["'][^>]*alt=["']([^"']*)["'][^>]*>/gi, "![$2]($1)")
		.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']*)["'][^>]*>/gi, "![$1]($2)")
		.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*>/gi, "![$1](...)")
		.replace(/<img[^>]*src=["']([^"']*)["'][^>]*>/gi, "![]($1)")
		.replace(/<img[^>]*>/gi, "")
		.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**")
		.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**")
		.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "_$1_")
		.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, "_$1_")
		.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
		.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n")
		.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
		.replace(/<\/[uo]l>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<p[^>]*>/gi, "")
		.replace(/<\/div>/gi, "\n")
		.replace(/<hr[^>]*>/gi, "\n---\n")
		.replace(/<[^>]+>/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeRegex(src: string): string {
	return src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeGlobPath(value: string): string {
	return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function globToRegExp(globPattern: string, caseSensitive: boolean): RegExp {
	let pattern = normalizeGlobPath(globPattern.trim());
	if (!pattern || pattern === ".") pattern = "**/*";
	if (!pattern.includes("/")) pattern = `**/${pattern}`;

	let out = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i]!;
		const next = pattern[i + 1];
		if (ch === "*") {
			if (next === "*") {
				const after = pattern[i + 2];
				if (after === "/") {
					out += "(?:.*/)?";
					i += 2;
				} else {
					out += ".*";
					i += 1;
				}
			} else {
				out += "[^/]*";
			}
			continue;
		}
		if (ch === "?") {
			out += "[^/]";
			continue;
		}
		out += escapeRegex(ch);
	}

	return new RegExp(`^${out}$`, caseSensitive ? "" : "i");
}

// ─────────────────────────────────────────────────────────────────────────────
// Todo — types and UI component
// ─────────────────────────────────────────────────────────────────────────────

interface Todo {
	id: number;
	text: string;
	done: boolean;
	cancelled?: boolean;
	inProgress?: boolean;
}

interface TodoDetails {
	summary: string;
	action: "list" | "add" | "in_progress" | "done" | "toggle" | "clear" | "cancel";
	todos: Todo[];
	nextId: number;
	id?: number;
	activeId: number | null;
}

interface AskDetails {
	summary: string;
	question: string;
	options: string[];
	answer: string | null;
	status: "answered" | "cancelled" | "unavailable";
	cancelled: boolean;
	unavailable: boolean;
	wasCustom: boolean;
	mode: "options" | "free_form";
}

class TodoListComponent {
	private todos: Todo[];
	private theme: Theme;
	private onClose: () => void;
	private cached?: string[];
	private cachedW?: number;

	constructor(todos: Todo[], theme: Theme, onClose: () => void) {
		this.todos = todos;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, "ctrl+c")) this.onClose();
	}

	render(width: number): string[] {
		if (this.cached && this.cachedW === width) return this.cached;
		const th = this.theme;
		const lines: string[] = [""];

		const title = th.fg("accent", " Todos ");
		lines.push(
			truncateToWidth(
				th.fg("borderMuted", "──") + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - TODO_TITLE_PADDING))),
				width,
			),
		);
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(truncateToWidth("  " + th.fg("dim", "No tasks."), width));
		} else {
			const dots = this.todos.map((t) =>
				t.cancelled
					? th.fg("warning", "◌")
					: t.inProgress
						? th.fg("accent", "◍")
						: t.done
							? th.fg("success", "●")
							: th.fg("dim", "○")
			).join("");

			lines.push(truncateToWidth("  " + dots, width));
			lines.push("");

			for (const todo of this.todos) {
				if (todo.cancelled) {
					lines.push(truncateToWidth(`  ${th.fg("dim", "×")} ${th.fg("dim", `#${todo.id}`)} ${th.fg("dim", todo.text)}`, width));
					continue;
				}

				const check = todo.inProgress
					? th.fg("accent", "▶")
					: todo.done
						? th.fg("success", "●")
						: th.fg("dim", "○");
				const id = th.fg("accent", `#${todo.id}`);
				const text = todo.done ? th.fg("dim", todo.text) : th.fg("text", todo.text);
				lines.push(truncateToWidth(`  ${check} ${id} ${text}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth("  " + th.fg("dim", "Esc — exit"), width));
		lines.push("");

		this.cached = lines;
		this.cachedW = width;
		return lines;
	}

	invalidate(): void {
		this.cached = undefined;
		this.cachedW = undefined;
	}
}

function getInProgressTodo(list: Todo[]): Todo | undefined {
	return list.find((t) => t.inProgress && !t.done && !t.cancelled);
}

function normalizeTodoState(list: Todo[]): void {
	let active: Todo | undefined;
	for (const t of list) {
		if (t.done || t.cancelled) t.inProgress = false;
		if (t.inProgress && !t.done && !t.cancelled) {
			if (!active) active = t;
			else t.inProgress = false;
		}
	}
}

function assignInProgress(list: Todo[], id: number): Todo | undefined {
	let selected: Todo | undefined;
	for (const t of list) {
		if (t.id === id) {
			t.inProgress = !t.done && !t.cancelled;
			selected = t;
		} else {
			t.inProgress = false;
		}
	}
	return selected;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main extension function
// ─────────────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const enabledTools = resolveEnabledBaseTools();
	const hasTool = (name: BaseToolName) => enabledTools.has(name);

	let todos: Todo[] = [];
	let nextTodoId = 1;

	const reconstructTodos = (ctx: ExtensionContext) => {
		todos = [];
		nextTodoId = 1;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
			const d = msg.details as TodoDetails | undefined;
			if (d && Array.isArray(d.todos) && typeof d.nextId === "number") {
				todos = d.todos;
				nextTodoId = d.nextId;
			}
		}
		normalizeTodoState(todos);
		const maxId = todos.reduce((max, t) => Math.max(max, t.id), 0);
		if (nextTodoId <= maxId) nextTodoId = maxId + 1;
	};

	const updateWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;

		const belowEditorWidgetKey = "todos-below";
		ctx.ui.setStatus("base-tools-todo", undefined);

		if (todos.length === 0) {
			ctx.ui.setWidget(belowEditorWidgetKey, undefined);
			return;
		}

		ctx.ui.setWidget(belowEditorWidgetKey, (_tui, theme) => {
			const container = new Container();
			const borderFn = (s: string) => theme.fg("dim", s);

			container.addChild(new Text("", 0, 0));
			container.addChild(new DynamicBorder(borderFn));
			const content = new Text("", 1, 0);
			container.addChild(content);
			container.addChild(new DynamicBorder(borderFn));

			return {
				render(width: number): string[] {
					if (todos.length === 0) return [];

					const activeNow = todos.filter((t) => !t.cancelled);
					const current = getInProgressTodo(activeNow) ?? activeNow.find((t) => !t.done && !t.cancelled);
					const dots = todos.map((t) =>
						t.cancelled
							? theme.fg("warning", "◌")
							: t.inProgress
								? theme.fg("accent", "◍")
								: t.done
									? theme.fg("success", "●")
									: theme.fg("dim", "○")
					).join("");
					const line =
						theme.fg("dim", " TODO ") +
						dots +
						(current
							? theme.fg("dim", "  → ") + theme.fg("muted", `#${current.id} ${current.text}`)
							: activeNow.length > 0
								? theme.fg("dim", "  ") + theme.fg("success", "Done!")
								: theme.fg("dim", "  ") + theme.fg("warning", "Cancelled"));

					content.setText(truncateToWidth(line, Math.max(1, width - 4)));
					return container.render(width);
				},
				invalidate() { container.invalidate(); },
			};
		}, { placement: "belowEditor" });
	};

	if (hasTool("todo")) {
		pi.on("session_start", async (_e, ctx) => {
			reconstructTodos(ctx);
			updateWidget(ctx);
		});

		pi.on("session_switch", async (_e, ctx) => {
			reconstructTodos(ctx);
			updateWidget(ctx);
		});

		pi.on("session_fork", async (_e, ctx) => {
			reconstructTodos(ctx);
			updateWidget(ctx);
		});

		pi.on("session_tree", async (_e, ctx) => {
			reconstructTodos(ctx);
			updateWidget(ctx);
		});

		pi.on("tool_result", async (event, ctx) => {
			if (event.toolName === "todo") updateWidget(ctx);
		});
	}

	// ── 1. WEB_FETCH ─────────────────────────────────────────────────────────

	const WEB_FETCH_MAX_BYTES = DEFAULT_MAX_BYTES; // 50 KB
	const WEB_FETCH_TIMEOUT_MS = 30_000;
	const WEB_FETCH_MAX_TIMEOUT_MS = 120_000;

	if (hasTool("web_fetch")) {
		pi.registerTool({
			name: "web_fetch",
			label: "WebFetch",
			description:
				"Fetches a URL and returns its content. HTML is automatically converted to Markdown. " +
				`Result is truncated to ${WEB_FETCH_MAX_BYTES / 1024}KB. ` +
				"Supports only http:// and https:// protocols.",
			promptSnippet: "Fetch a URL and return its content as text or markdown",
			promptGuidelines: [
				"Use web_fetch when you need to read documentation, check a webpage, or extract information from a URL.",
				"Prefer markdown format for structured content; use text for plain content extraction.",
				"The result may be truncated for large pages - consider using bash with curl for full content.",
			],
			parameters: Type.Object({
				url: Type.String({ description: "URL to fetch (http:// or https://)" }),
				format: Type.Optional(
					StringEnum(["markdown", "text", "html"] as const, {
						description: 'Output format: "markdown" (default), "text", "html"',
					}),
				),
				timeout: Type.Optional(
					Type.Number({ description: "Timeout in seconds (max 120, default 30)" }),
				),
			}),

			async execute(_id, params, signal, onUpdate) {
				const { url, format = "markdown", timeout } = params;

				let parsedUrl: URL;
				try {
					parsedUrl = new URL(url);
				} catch {
					throw invalidArgument("Unable to parse URL", "Provide a valid http:// or https:// URL");
				}

				if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
					throw invalidArgument("URL must use http:// or https://", "Retry with an http or https URL");
				}

				const blockedHostnames = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]"];
				const hostname = parsedUrl.hostname.toLowerCase();
				if (blockedHostnames.includes(hostname) || hostname.startsWith("127.") || hostname.startsWith("10.") || hostname.startsWith("192.168.") || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)) {
					throw invalidArgument("Local or internal addresses are not allowed", "Retry with a public URL");
				}

				if (timeout !== undefined && (timeout < 1 || timeout > WEB_FETCH_MAX_TIMEOUT_MS / 1000)) {
					throw invalidArgument("timeout must be between 1 and 120 seconds", "Retry with timeout in the range 1-120");
				}

				const timeoutMs = (timeout ?? WEB_FETCH_TIMEOUT_MS / 1000) * 1000;

				let response: Response | undefined;
				let lastError: Error | undefined;

				for (let attempt = 0; attempt < WEB_FETCH_MAX_RETRIES; attempt++) {
					const humanAttempt = attempt + 1;
					onUpdate?.({ content: [{ type: "text", text: `Fetching ${url} (attempt ${humanAttempt}/${WEB_FETCH_MAX_RETRIES})...` }] });

					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(), timeoutMs);
					const fetchSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;

					try {
						const fetchOptions: RequestInit = {
							signal: fetchSignal,
							headers: {
								"User-Agent": attempt === 0
									? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
									: "pi-coding-agent",
								Accept:
									format === "html"
										? "text/html,*/*;q=0.9"
										: format === "text"
											? "text/plain,text/html;q=0.8,*/*;q=0.5"
											: "text/markdown,text/html;q=0.8,text/plain;q=0.6,*/*;q=0.3",
								"Accept-Language": "en-US,en;q=0.9",
							},
						};

						response = await fetch(url, fetchOptions);

						if (!response.ok) {
							const shouldRetry = WEB_FETCH_RETRY_STATUS_CODES.includes(response.status) ||
								(response.status === 403 && response.headers.get("cf-mitigated") === "challenge");

							if (shouldRetry && attempt < WEB_FETCH_MAX_RETRIES - 1) {
								const backoffMs = Math.min(WEB_FETCH_BASE_BACKOFF_MS * Math.pow(2, attempt), WEB_FETCH_MAX_BACKOFF_MS);
								onUpdate?.({ content: [{ type: "text", text: `Retrying in ${Math.ceil(backoffMs / 1000)}s...` }] });
								await delay(backoffMs);
								continue;
							}
						}

						break;
					} catch (err) {
						lastError = err instanceof Error ? err : new Error(String(err));
						if (attempt < WEB_FETCH_MAX_RETRIES - 1) {
							const backoffMs = Math.min(WEB_FETCH_BASE_BACKOFF_MS * Math.pow(2, attempt), WEB_FETCH_MAX_BACKOFF_MS);
							onUpdate?.({ content: [{ type: "text", text: `Network error, retrying in ${Math.ceil(backoffMs / 1000)}s...` }] });
							await delay(backoffMs);
							continue;
						}
					} finally {
						clearTimeout(timer);
					}
				}

				if (!response) {
					if (lastError) {
						throw temporaryUnavailable(lastError.message, "Retry in a moment or try bash with curl for diagnostics");
					}
					throw temporaryUnavailable("Failed to fetch URL after multiple attempts", "Retry in a moment or try bash with curl for diagnostics");
				}

				if (!response.ok) {
					if (response.status === 401 || response.status === 403) {
						throw unauthorized(`HTTP ${response.status}: ${response.statusText}`, "Check whether the URL requires authentication or different headers");
					}
					if (response.status === 404) {
						throw notFound("URL returned 404 Not Found", "Verify the URL and retry");
					}
					if (response.status === 429) {
						throw rateLimited("Remote server rate limited the request", "Retry later or reduce request frequency");
					}
					if (response.status >= 500) {
						throw temporaryUnavailable(`HTTP ${response.status}: ${response.statusText}`, "Retry later or use bash with curl for diagnostics");
					}
					throw invalidArgument(`HTTP ${response.status}: ${response.statusText}`, "Check the URL and retry with different parameters if needed");
				}

				const rawText = await response.text();
				const contentType = response.headers.get("content-type") ?? "";
				const isHtml = contentType.includes("text/html") || rawText.trimStart().startsWith("<");

				let body: string;
				if (format === "html") {
					body = rawText;
				} else if (format === "text") {
					body = isHtml ? htmlToMarkdown(rawText).replace(/[#*`_\[\]]/g, "") : rawText;
				} else {
					body = isHtml ? htmlToMarkdown(rawText) : rawText;
				}

				const truncation = truncateHead(body, {
					maxBytes: WEB_FETCH_MAX_BYTES,
					maxLines: 2000,
				});

				let result = truncation.content;
				if (truncation.truncated) {
					result += `\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}. Use bash with curl for full content.]`;
				}

				return {
					content: [{ type: "text" as const, text: result }],
					details: conciseDetails(`Fetched ${url}${truncation.truncated ? " (truncated)" : ""}`, {
						url,
						format,
						contentType,
						truncated: truncation.truncated,
						bytes: truncation.outputBytes,
						totalBytes: truncation.totalBytes,
					}),
				};
			},

			renderCall(args, theme) {
				return new Text(
					theme.fg("toolTitle", theme.bold("web_fetch ")) +
						theme.fg("accent", args.url ?? "") +
						(args.format ? theme.fg("dim", ` [${args.format}]`) : ""),
					0,
					0,
				);
			},

			renderResult(result, _opts, theme) {
				const d = result.details as { url: string; format: string; truncated: boolean; bytes: number } | undefined;
				if (!d) {
					const t = result.content[0];
					return new Text(t?.type === "text" ? t.text.slice(0, 120) : "", 0, 0);
				}
				const size = formatSize(d.bytes);
				const trunc = d.truncated ? theme.fg("warning", " (truncated)") : "";
				return new Text(theme.fg("success", "✓ ") + theme.fg("dim", `${d.format} · ${size}`) + trunc, 0, 0);
			},
		});
	}

	// ── 2. TODO ──────────────────────────────────────────────────────────────

	const TodoParams = Type.Object({
		action: StringEnum(["list", "add", "in_progress", "done", "toggle", "cancel", "clear"] as const, {
			description: "list — show all; add — create new (requires text); in_progress — set active task (requires id); done — complete active task (requires id); toggle — toggle completion status (requires id); cancel — cancel task (requires id); clear — remove all",
		}),
		text: Type.Optional(Type.String({ description: 'Task text (required for action="add")' })),
		id: Type.Optional(Type.Number({ description: 'Task ID (required for action="in_progress", "done", "toggle" or "cancel")' })),
	});

	if (hasTool("todo")) {
		pi.registerTool({
			name: "todo",
			label: "Todo",
			description:
				"Manages a persistent todo list. Supports disciplined workflow with one active in-progress task at a time. " +
				"Actions: list, add, in_progress, done, toggle, cancel, clear.",
			promptSnippet: "Manage a persistent todo list across the session",
			promptGuidelines: [
				"Use todo to track multi-step tasks and show progress to the user.",
				"Call todo list at the start of a session to check for existing tasks.",
				"Set exactly one active task with todo in_progress before execution.",
				"Mark only the active task as done, then move in_progress to the next task.",
				"Use cancel for abandoned tasks so they are not shown as completed.",
			],
			parameters: TodoParams,

			async execute(_id, params) {
				normalizeTodoState(todos);

				switch (params.action) {
					case "list": {
						const text =
							todos.length > 0
								? todos.map((t) => `[${t.cancelled ? "-" : t.inProgress ? ">" : t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
								: "No tasks";
						return {
							content: [{ type: "text" as const, text }],
							details: {
								summary: `Listed ${todos.length} task(s)`,
								action: "list",
								todos: [...todos],
								nextId: nextTodoId,
								activeId: getInProgressTodo(todos)?.id ?? null,
							} as TodoDetails,
						};
					}

					case "add": {
						if (!params.text || !params.text.trim()) {
							throw invalidArgument("text is required for action=add", "Retry with a non-empty text field");
						}
						while (todos.some((t) => t.id === nextTodoId)) nextTodoId++;
						const newTodo: Todo = { id: nextTodoId++, text: params.text.trim(), done: false, cancelled: false, inProgress: false };
						todos.push(newTodo);

						if (!getInProgressTodo(todos) && todos.filter((t) => !t.done && !t.cancelled).length === 1) {
							newTodo.inProgress = true;
						}

						return {
							content: [{ type: "text" as const, text: `Added #${newTodo.id}: ${newTodo.text}` }],
							details: {
								summary: `Added task #${newTodo.id}`,
								action: "add",
								todos: [...todos],
								nextId: nextTodoId,
								id: newTodo.id,
								activeId: getInProgressTodo(todos)?.id ?? null,
							} as TodoDetails,
						};
					}

					case "in_progress": {
						if (params.id === undefined) {
							throw invalidArgument("id is required for action=in_progress", "Retry with task ID to activate");
						}
						const selected = todos.find((t) => t.id === params.id);
						if (!selected) throw notFound(`Task #${params.id} not found`, "Call todo list to inspect valid task IDs");
						if (selected.done || selected.cancelled) {
							throw invalidArgument(`Task #${selected.id} is not active (done/cancelled)`, "Choose an open task for in_progress");
						}
						assignInProgress(todos, selected.id);
						return {
							content: [{ type: "text" as const, text: `Task #${selected.id} is now in progress` }],
							details: {
								summary: `Activated task #${selected.id}`,
								action: "in_progress",
								todos: [...todos],
								nextId: nextTodoId,
								id: selected.id,
								activeId: selected.id,
							} as TodoDetails,
						};
					}

					case "done": {
						if (params.id === undefined) {
							throw invalidArgument("id is required for action=done", "Retry with the active task id to complete");
						}
						const todo = todos.find((t) => t.id === params.id);
						if (!todo) throw notFound(`Task #${params.id} not found`, "Call todo list to inspect valid task IDs");
						const active = getInProgressTodo(todos);
						if (!active || active.id !== todo.id) {
							throw invalidArgument(
								`Task #${todo.id} is not the active in-progress task`,
								`Call todo in_progress id=${todo.id} before marking it done`,
							);
						}
						todo.cancelled = false;
						todo.done = true;
						todo.inProgress = false;
						return {
							content: [{ type: "text" as const, text: `Task #${todo.id} completed ✓` }],
							details: {
								summary: `Completed task #${todo.id}`,
								action: "done",
								todos: [...todos],
								nextId: nextTodoId,
								id: todo.id,
								activeId: getInProgressTodo(todos)?.id ?? null,
							} as TodoDetails,
						};
					}

					case "toggle": {
						if (params.id === undefined) {
							throw invalidArgument("id is required for action=toggle", "Retry with the task id to toggle");
						}
						const todo = todos.find((t) => t.id === params.id);
						if (!todo) throw notFound(`Task #${params.id} not found`, "Call todo list to inspect valid task IDs");

						if (!todo.done) {
							const active = getInProgressTodo(todos);
							if (!active || active.id !== todo.id) {
								throw invalidArgument(`Task #${todo.id} is not the active in-progress task`, `Call todo in_progress id=${todo.id} before completing it`);
							}
						}

						todo.cancelled = false;
						todo.done = !todo.done;
						todo.inProgress = false;
						normalizeTodoState(todos);
						return {
							content: [{ type: "text" as const, text: `Task #${todo.id} ${todo.done ? "completed" : "reopened"} ✓` }],
							details: {
								summary: `${todo.done ? "Completed" : "Reopened"} task #${todo.id}`,
								action: "toggle",
								todos: [...todos],
								nextId: nextTodoId,
								id: todo.id,
								activeId: getInProgressTodo(todos)?.id ?? null,
							} as TodoDetails,
						};
					}

					case "cancel": {
						if (params.id === undefined) {
							throw invalidArgument("id is required for action=cancel", "Retry with the task id to cancel");
						}
						const todo = todos.find((t) => t.id === params.id);
						if (!todo) throw notFound(`Task #${params.id} not found`, "Call todo list to inspect valid task IDs");
						todo.done = false;
						todo.cancelled = true;
						todo.inProgress = false;
						normalizeTodoState(todos);
						return {
							content: [{ type: "text" as const, text: `Task #${todo.id} cancelled` }],
							details: {
								summary: `Cancelled task #${todo.id}`,
								action: "cancel",
								todos: [...todos],
								nextId: nextTodoId,
								id: todo.id,
								activeId: getInProgressTodo(todos)?.id ?? null,
							} as TodoDetails,
						};
					}

					case "clear": {
						const count = todos.length;
						todos = [];
						return {
							content: [{ type: "text" as const, text: `Cleared ${count} tasks` }],
							details: {
								summary: `Cleared ${count} task(s)`,
								action: "clear",
								todos: [],
								nextId: nextTodoId,
								activeId: null,
							} as TodoDetails,
						};
					}
				}
			},

			renderCall(args, theme) {
				let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
				if (args.text) text += " " + theme.fg("dim", `"${args.text}"`);
				if (args.id !== undefined) text += " " + theme.fg("accent", `#${args.id}`);
				return new Text(text, 0, 0);
			},

			renderResult(result, { expanded }, theme) {
				const d = result.details as TodoDetails | undefined;
				if (!d) {
					const t = result.content[0];
					return new Text(t?.type === "text" ? t.text : "", 0, 0);
				}

				const list = d.todos;
				switch (d.action) {
					case "list": {
						if (list.length === 0) return new Text(theme.fg("dim", "No tasks"), 0, 0);
						const active = list.filter((t) => !t.cancelled);
						const done = active.filter((t) => t.done).length;
						const cancelled = list.filter((t) => t.cancelled).length;
						let txt = theme.fg("muted", `${done}/${active.length} done`) +
							(cancelled > 0 ? theme.fg("warning", ` · ${cancelled} cancelled`) : "") +
							theme.fg("muted", d.activeId ? ` · active #${d.activeId}` : "") +
							theme.fg("muted", ":");
						const show = expanded ? list : list.slice(0, 5);
						for (const t of show) {
							const check = t.cancelled
								? theme.fg("warning", "−")
								: t.inProgress
									? theme.fg("accent", "▶")
									: t.done
										? theme.fg("success", "✓")
										: theme.fg("dim", "○");
							const id = t.cancelled ? theme.fg("warning", `#${t.id}`) : theme.fg("accent", `#${t.id}`);
							const label = t.cancelled
								? theme.fg("warning", t.text)
								: t.done
									? theme.fg("dim", t.text)
									: theme.fg("muted", t.text);
							txt += `\n${check} ${id} ${label}`;
						}
						if (!expanded && list.length > 5) txt += `\n${theme.fg("dim", `... ${list.length - 5} more`)}`;
						return new Text(txt, 0, 0);
					}
					case "add":
					case "in_progress":
					case "done":
					case "toggle": {
						const t = result.content[0];
						const msg = t?.type === "text" ? t.text : "";
						return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
					}
					case "cancel": {
						const t = result.content[0];
						const msg = t?.type === "text" ? t.text : "";
						return new Text(theme.fg("warning", "− ") + theme.fg("muted", msg), 0, 0);
					}
					case "clear":
						return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "List cleared"), 0, 0);
				}
			},
		});

		pi.registerCommand("todos", {
			description: "Show todo list",
			handler: async (_args, ctx) => {
				if (!ctx.hasUI) {
					ctx.ui.notify("/todos requires interactive mode", "error");
					return;
				}
				await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
					return new TodoListComponent([...todos], theme, () => done(undefined));
				});
			},
		});
	}

	// ── 3. ASK_USER ──────────────────────────────────────────────────────────

	const AskUserParams = Type.Object({
		question: Type.String({ description: "Question to ask the user" }),
		options: Type.Optional(
			Type.Array(Type.String(), {
				description: "Answer options. If not provided, free-form input field is shown",
			}),
		),
	});

	if (hasTool("ask_user")) {
		pi.registerTool({
			name: "ask_user",
			label: "AskUser",
			description:
				"Asks the user a question and waits for their response. Use when you need clarification before proceeding. " +
				"You can provide answer options or leave it as free-form input.",
			promptSnippet: "Ask the user a question and wait for their answer before proceeding",
			promptGuidelines: [
				"Use ask_user when the task is ambiguous and you need clarification before writing code or making changes.",
				"Prefer ask_user over guessing when multiple valid interpretations exist.",
				"Provide specific options when the user needs to choose between concrete alternatives.",
				"Use free-form input (no options) when you need open-ended feedback or creative input.",
			],
			parameters: AskUserParams,

			async execute(_id, params, _signal, _onUpdate, ctx) {
				if (!ctx.hasUI) {
					return {
						content: [{ type: "text" as const, text: "UI unavailable (non-interactive mode)" }],
						details: {
							summary: "User interaction unavailable",
							question: params.question,
							options: params.options ?? [],
							answer: null,
							status: "unavailable",
							cancelled: false,
							unavailable: true,
							wasCustom: false,
							mode: params.options?.length ? "options" : "free_form",
						} as AskDetails,
					};
				}

				const options = params.options ?? [];
				const hasOptions = options.length > 0;

				if (hasOptions) {
					const allOpts = [...options, "✏️  Write manually..."];
					const result = await ctx.ui.custom<{ answer: string; wasCustom: boolean } | null>((tui, theme, _kb, done) => {
						let idx = 0;
						let editMode = false;
						let cached: string[] | undefined;

						const editorTheme: EditorTheme = {
							borderColor: (s) => theme.fg("accent", s),
							selectList: {
								selectedPrefix: (t) => theme.fg("accent", t),
								selectedText: (t) => theme.fg("accent", t),
								description: (t) => theme.fg("muted", t),
								scrollInfo: (t) => theme.fg("dim", t),
								noMatch: (t) => theme.fg("warning", t),
							},
						};
						const editor = new Editor(tui, editorTheme);
						editor.onSubmit = (value) => {
							const v = value.trim();
							if (v) done({ answer: v, wasCustom: true });
							else {
								editMode = false;
								editor.setText("");
								cached = undefined;
								tui.requestRender();
							}
						};

						function handleInput(data: string) {
							if (editMode) {
								if (matchesKey(data, Key.escape)) {
									editMode = false;
									editor.setText("");
									cached = undefined;
									tui.requestRender();
									return;
								}
								editor.handleInput(data);
								cached = undefined;
								tui.requestRender();
								return;
							}
							if (matchesKey(data, Key.up)) { idx = Math.max(0, idx - 1); cached = undefined; tui.requestRender(); return; }
							if (matchesKey(data, Key.down)) { idx = Math.min(allOpts.length - 1, idx + 1); cached = undefined; tui.requestRender(); return; }
							if (matchesKey(data, Key.enter)) {
								if (idx === allOpts.length - 1) {
									editMode = true;
									cached = undefined;
									tui.requestRender();
								} else {
									done({ answer: allOpts[idx]!, wasCustom: false });
								}
								return;
							}
							if (matchesKey(data, Key.escape)) done(null);
						}

						function render(width: number): string[] {
							if (cached) return cached;
							const lines: string[] = [];
							const add = (s: string) => lines.push(truncateToWidth(s, width));

							add(theme.fg("accent", "─".repeat(width)));
							add(theme.fg("text", ` ${params.question}`));
							lines.push("");

							for (let i = 0; i < allOpts.length; i++) {
								const sel = i === idx;
								const isLast = i === allOpts.length - 1;
								const prefix = sel ? theme.fg("accent", "> ") : "  ";
								const label = isLast
									? (sel ? theme.fg("accent", allOpts[i]!) : theme.fg("dim", allOpts[i]!))
									: (sel ? theme.fg("accent", `${i + 1}. ${allOpts[i]}`) : theme.fg("text", `${i + 1}. ${allOpts[i]}`));
								add(prefix + label);
							}

							if (editMode) {
								lines.push("");
								add(theme.fg("muted", " Your answer:"));
								for (const line of editor.render(width - 2)) add(` ${line}`);
								lines.push("");
								add(theme.fg("dim", " Enter — send · Esc — back"));
							} else {
								lines.push("");
								add(theme.fg("dim", " ↑↓ — select · Enter — confirm · Esc — cancel"));
							}
							add(theme.fg("accent", "─".repeat(width)));

							cached = lines;
							return lines;
						}

						return {
							render,
							invalidate: () => { cached = undefined; },
							handleInput,
						};
					});

					if (!result) {
						return {
							content: [{ type: "text" as const, text: "User cancelled the selection" }],
							details: {
								summary: "User cancelled selection",
								question: params.question,
								options,
								answer: null,
								status: "cancelled",
								cancelled: true,
								unavailable: false,
								wasCustom: false,
								mode: "options",
							} as AskDetails,
						};
					}
					return {
						content: [{ type: "text" as const, text: result.wasCustom ? `User wrote: ${result.answer}` : `User selected: ${result.answer}` }],
						details: {
							summary: result.wasCustom ? "User provided custom answer" : "User selected option",
							question: params.question,
							options,
							answer: result.answer,
							status: "answered",
							cancelled: false,
							unavailable: false,
							wasCustom: result.wasCustom,
							mode: "options",
						} as AskDetails,
					};
				}

				const answer = await ctx.ui.input(params.question);
				if (answer === undefined || answer === null) {
					return {
						content: [{ type: "text" as const, text: "User cancelled input" }],
						details: {
							summary: "User cancelled input",
							question: params.question,
							options: [],
							answer: null,
							status: "cancelled",
							cancelled: true,
							unavailable: false,
							wasCustom: false,
							mode: "free_form",
						} as AskDetails,
					};
				}
				return {
					content: [{ type: "text" as const, text: `User answered: ${answer}` }],
					details: {
						summary: "User answered question",
						question: params.question,
						options: [],
						answer,
						status: "answered",
						cancelled: false,
						unavailable: false,
						wasCustom: false,
						mode: "free_form",
					} as AskDetails,
				};
			},

			renderCall(args, theme) {
				let text = theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", args.question ?? "");
				const opts = args.options as string[] | undefined;
				if (opts?.length) {
					const numbered = [...opts, "✏️ ..."].map((o, i) => `${i + 1}. ${o}`);
					text += "\n" + theme.fg("dim", `  Options: ${numbered.join(", ")}`);
				}
				return new Text(text, 0, 0);
			},

			renderResult(result, _opts, theme) {
				const d = result.details as AskDetails | undefined;
				if (!d) {
					const t = result.content[0];
					return new Text(t?.type === "text" ? t.text : "", 0, 0);
				}
				if (d.status === "unavailable") return new Text(theme.fg("warning", "UI unavailable"), 0, 0);
				if (d.status === "cancelled") return new Text(theme.fg("warning", "Cancelled"), 0, 0);
				const prefix = d.wasCustom ? theme.fg("muted", "(wrote) ") : theme.fg("muted", "(selected) ");
				return new Text(theme.fg("success", "✓ ") + prefix + theme.fg("accent", d.answer ?? ""), 0, 0);
			},
		});
	}

	// ── 4. GLOB ──────────────────────────────────────────────────────────────

	const GlobParams = Type.Object({
		pattern: Type.String({ description: "Glob pattern (e.g. **/*.ts, src/**/test-*.ts)" }),
		cwd: Type.Optional(Type.String({ description: "Search root relative to current working directory" })),
		limit: Type.Optional(Type.Number({ description: "Maximum number of matches (default 200, max 2000)" })),
		ignore: Type.Optional(Type.Array(Type.String(), { description: "Glob patterns to exclude from results" })),
		include_dirs: Type.Optional(Type.Boolean({ description: "Include directory matches (default false)" })),
		case_sensitive: Type.Optional(Type.Boolean({ description: "Case sensitive matching (default false)" })),
	});

	if (hasTool("glob")) {
		pi.registerTool({
			name: "glob",
			label: "Glob",
			description:
				"Find files by glob pattern with bounded output. Use for file discovery before read/edit operations. " +
				"Supports ignore filters and optional directory inclusion.",
			promptSnippet: "Find files matching a glob pattern",
			promptGuidelines: [
				"Use glob for file discovery instead of broad shell commands when possible.",
				"Keep patterns focused and use ignore to skip noisy directories.",
				"Use limit to keep output concise, then narrow pattern for follow-up calls.",
			],
			parameters: GlobParams,

			async execute(_id, params, signal, onUpdate, ctx) {
				const pattern = params.pattern?.trim();
				if (!pattern) {
					throw invalidArgument("pattern is required", "Retry with a non-empty glob pattern");
				}

				const limit = params.limit ?? GLOB_DEFAULT_LIMIT;
				if (!Number.isFinite(limit) || limit < 1 || limit > GLOB_MAX_LIMIT) {
					throw invalidArgument(`limit must be between 1 and ${GLOB_MAX_LIMIT}`, `Retry with limit in range 1-${GLOB_MAX_LIMIT}`);
				}

				const root = resolve(ctx.cwd, params.cwd ?? ".");
				const base = resolve(ctx.cwd);
				const relFromBase = relative(base, root);
				if (relFromBase.startsWith("..") || relFromBase.includes("..\\") || relFromBase.includes("../")) {
					throw invalidArgument("cwd must stay inside the current workspace", "Retry with a workspace-relative cwd");
				}

				const matcher = globToRegExp(pattern, params.case_sensitive ?? false);
				const ignoreMatchers = (params.ignore ?? []).map((p) => globToRegExp(p, params.case_sensitive ?? false));
				const includeDirs = params.include_dirs ?? false;

				const queue: string[] = [root];
				const matches: string[] = [];
				let scanned = 0;
				let truncated = false;

				while (queue.length > 0) {
					if (signal?.aborted) throw temporaryUnavailable("glob operation was aborted", "Retry with a narrower pattern or smaller scope");

					const currentDir = queue.shift()!;
					let entries: Dirent[];
					try {
						entries = await readdir(currentDir, { withFileTypes: true });
					} catch {
						continue;
					}

					for (const entry of entries) {
						const fullPath = resolve(currentDir, entry.name);
						const relPath = normalizeGlobPath(relative(root, fullPath));
						if (!relPath || relPath.startsWith("..")) continue;

						const ignored = ignoreMatchers.some((rx) => rx.test(relPath));
						if (ignored) continue;

						if (entry.isDirectory()) {
							queue.push(fullPath);
							if (includeDirs && matcher.test(relPath)) {
								matches.push(relPath + "/");
								if (matches.length >= limit) {
									truncated = true;
									break;
								}
							}
						} else if (entry.isFile()) {
							if (matcher.test(relPath)) {
								matches.push(relPath);
								if (matches.length >= limit) {
									truncated = true;
									break;
								}
							}
						} else {
							// fallback for special types (symlink, etc.)
							try {
								const st = await stat(fullPath);
								if (st.isDirectory()) queue.push(fullPath);
								if (st.isFile() && matcher.test(relPath)) {
									matches.push(relPath);
									if (matches.length >= limit) {
										truncated = true;
										break;
									}
								}
							} catch {}
						}

						scanned++;
						if (scanned % 300 === 0) {
							onUpdate?.({ content: [{ type: "text", text: `glob: scanned ${scanned} entries, found ${matches.length}...` }] });
						}
					}

					if (truncated) break;
				}

				matches.sort((a, b) => a.localeCompare(b));
				const text = matches.length > 0 ? matches.join("\n") : "No matches";

				return {
					content: [{ type: "text" as const, text }],
					details: conciseDetails(`Found ${matches.length} path(s) for ${pattern}${truncated ? " (truncated)" : ""}`, {
						pattern,
						cwd: params.cwd ?? ".",
						count: matches.length,
						limit,
						truncated,
						items: matches,
					}),
				};
			},

			renderCall(args, theme) {
				return new Text(
					theme.fg("toolTitle", theme.bold("glob ")) +
						theme.fg("accent", args.pattern ?? "") +
						(args.cwd ? theme.fg("dim", ` @${args.cwd}`) : ""),
					0,
					0,
				);
			},

			renderResult(result, _opts, theme) {
				const d = result.details as { count?: number; truncated?: boolean } | undefined;
				if (!d) return new Text(theme.fg("dim", "glob done"), 0, 0);
				return new Text(
					theme.fg("success", "✓ ") +
					theme.fg("muted", `${d.count ?? 0} match(es)`) +
					(d.truncated ? theme.fg("warning", " (truncated)") : ""),
					0,
					0,
				);
			},
		});
	}
}
