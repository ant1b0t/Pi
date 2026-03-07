/**
 * base-tools — Glob, Grep, Ls, WebFetch, Todo, AskUser
 *
 * Activates built-in Pi tools (grep, find, ls) and adds:
 *   • web_fetch  — URL fetching with HTML→Markdown conversion
 *   • todo       — task list with UI widget and /todos command
 *   • ask_user   — interactive dialog with question and answer options
 *
 * Usage: pi -e extensions/base-tools.ts
 *        pi --tools read,bash,edit,write,grep,find,ls -e extensions/base-tools.ts
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const TODO_PROGRESS_BAR_WIDTH = 10;
const TODO_TITLE_PADDING = 10;
const WEB_FETCH_MAX_RETRIES = 3;
const WEB_FETCH_BASE_BACKOFF_MS = 1000;
const WEB_FETCH_MAX_BACKOFF_MS = 10000;
const WEB_FETCH_RETRY_STATUS_CODES = [429, 500, 502, 503, 504];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Decode all HTML entities including numeric and named */
function decodeHtmlEntities(text: string): string {
	// Named entities map (common ones)
	const namedEntities: Record<string, string> = {
		amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
		nbsp: ' ', copy: '©', reg: '®', trade: '™',
		mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»',
		ldquo: '"', rdquo: '"', lsquo: "'", rsquo: "'",
		bull: '•', middot: '·', sect: '§', para: '¶'
	};

	return text
		// Numeric entities: &#123; or &#x7B;
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
		// Named entities: &name;
		.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name) => namedEntities[name] ?? match);
}

/** Примитивный HTML → Markdown конвертер без внешних зависимостей */
function htmlToMarkdown(html: string): string {
	const decoded = decodeHtmlEntities(html);
	
	return decoded
		// Убираем <script> и <style> целиком
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		// Заголовки
		.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
		.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
		.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
		.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n")
		.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n")
		.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n")
		// Ссылки и изображения (поддержка одинарных и двойных кавычек)
		.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
		.replace(/<img[^>]*src=["']([^"']*)["'][^>]*alt=["']([^"']*)["'][^>]*>/gi, "![$2]($1)")
		.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']*)["'][^>]*>/gi, "![$1]($2)")
		.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*>/gi, "![$1](...)")
		.replace(/<img[^>]*src=["']([^"']*)["'][^>]*>/gi, "![]($1)")
		.replace(/<img[^>]*>/gi, "")
		// Форматирование текста
		.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**")
		.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**")
		.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "_$1_")
		.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, "_$1_")
		.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
		.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n")
		// Списки
		.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
		.replace(/<\/[uo]l>/gi, "\n")
		// Параграфы и переносы
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<p[^>]*>/gi, "")
		.replace(/<\/div>/gi, "\n")
		.replace(/<hr[^>]*>/gi, "\n---\n")
		// Убираем оставшиеся теги
		.replace(/<[^>]+>/g, "")
		// Убираем множественные пустые строки
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Delay helper for retry logic */
function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Todo — типы и UI-компонент
// ─────────────────────────────────────────────────────────────────────────────

interface Todo {
	id: number;
	text: string;
	done: boolean;
}

interface TodoDetails {
	action: "list" | "add" | "done" | "toggle" | "clear";
	todos: Todo[];
	nextId: number;
	error?: string;
}

/** Панель /todos — показывает список с прогресс-баром */
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

		// Заголовок
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
			const done = this.todos.filter((t) => t.done).length;
			const total = this.todos.length;

			// Минималистичный прогресс-бар (точки)
			const filled = total > 0 ? Math.round((done / total) * TODO_PROGRESS_BAR_WIDTH) : 0;
			const dots = th.fg("success", "●".repeat(filled)) + th.fg("dim", "○".repeat(TODO_PROGRESS_BAR_WIDTH - filled));
			const progress = th.fg("accent", `${done}/${total}`) + "  " + dots;
			
			lines.push(truncateToWidth("  " + progress, width));
			lines.push("");

			for (const todo of this.todos) {
				const check = todo.done ? th.fg("success", "●") : th.fg("dim", "○");
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

// ─────────────────────────────────────────────────────────────────────────────
// Главная функция расширения
// ─────────────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── Состояние Todo (восстанавливается из сессии при session_start) ────────
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
			if (d) {
				todos = d.todos;
				nextTodoId = d.nextId;
			}
		}
	};

	const updateWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const pending = todos.filter((t) => !t.done).length;
		if (pending > 0) {
			ctx.ui.setWidget("todos", [
				ctx.theme.fg("warning", ` Pending: ${pending} tasks `),
			]);
		} else if (todos.length > 0) {
			ctx.ui.setWidget("todos", [
				ctx.theme.fg("success", ` All tasks completed! `),
			]);
		} else {
			ctx.ui.setWidget("todos", null);
		}
	};

	pi.on("session_start", async (_e, ctx) => {
		// Активируем встроенные тулзы grep / find / ls
		const active = pi.getActiveTools();
		const toAdd = ["grep", "find", "ls"].filter((t) => !active.includes(t));
		if (toAdd.length > 0) {
			pi.setActiveTools([...active, ...toAdd]);
		}

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
		if (event.toolName === "todo") {
			reconstructTodos(ctx);
			updateWidget(ctx);
		}
	});

	// ── 1. WEB_FETCH ─────────────────────────────────────────────────────────

	const WEB_FETCH_MAX_BYTES = DEFAULT_MAX_BYTES; // 50 KB
	const WEB_FETCH_TIMEOUT_MS = 30_000;
	const WEB_FETCH_MAX_TIMEOUT_MS = 120_000;

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

		async execute(_id, params, signal) {
			const { url, format = "markdown", timeout } = params;

			// Strict URL validation with SSRF protection
			let parsedUrl: URL;
			try {
				parsedUrl = new URL(url);
			} catch {
				throw new Error("Invalid URL: unable to parse");
			}
			
			// Protocol check
			if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
				throw new Error("URL must use http:// or https:// protocol");
			}
			
			// SSRF protection: block private/internal addresses
			const blockedHostnames = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]"];
			const hostname = parsedUrl.hostname.toLowerCase();
			if (blockedHostnames.includes(hostname) || hostname.startsWith("127.") || hostname.startsWith("10.") || hostname.startsWith("192.168.") || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)) {
				throw new Error("Access to local/internal addresses is not allowed");
			}

			// Таймаут
			const timeoutMs = Math.min(
				(timeout ?? WEB_FETCH_TIMEOUT_MS / 1000) * 1000,
				WEB_FETCH_MAX_TIMEOUT_MS,
			);

			// Fetch with retry logic and exponential backoff
			let response: Response | undefined;
			let lastError: Error | undefined;
			
			for (let attempt = 0; attempt < WEB_FETCH_MAX_RETRIES; attempt++) {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), timeoutMs);
				const fetchSignal = signal
					? AbortSignal.any([signal, controller.signal])
					: controller.signal;

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

					// Check if we should retry
					if (!response.ok) {
						const shouldRetry = WEB_FETCH_RETRY_STATUS_CODES.includes(response.status) || 
							(response.status === 403 && response.headers.get("cf-mitigated") === "challenge");
						
						if (shouldRetry && attempt < WEB_FETCH_MAX_RETRIES - 1) {
							const backoffMs = Math.min(
								WEB_FETCH_BASE_BACKOFF_MS * Math.pow(2, attempt),
								WEB_FETCH_MAX_BACKOFF_MS
							);
							await delay(backoffMs);
							continue;
						}
					}
					
					// Success or non-retryable error
					break;
				} catch (err) {
					lastError = err instanceof Error ? err : new Error(String(err));
					// Retry on network errors
					if (attempt < WEB_FETCH_MAX_RETRIES - 1) {
						const backoffMs = Math.min(
							WEB_FETCH_BASE_BACKOFF_MS * Math.pow(2, attempt),
							WEB_FETCH_MAX_BACKOFF_MS
						);
						await delay(backoffMs);
						continue;
					}
				} finally {
					clearTimeout(timer);
				}
			}

			if (!response) {
				throw lastError || new Error("Failed to fetch URL after multiple attempts");
			}

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			const rawText = await response.text();
			const contentType = response.headers.get("content-type") ?? "";
			const isHtml = contentType.includes("text/html") || rawText.trimStart().startsWith("<");

			// Конвертируем в нужный формат
			let body: string;
			if (format === "html") {
				body = rawText;
			} else if (format === "text") {
				body = isHtml ? htmlToMarkdown(rawText).replace(/[#*`_\[\]]/g, "") : rawText;
			} else {
				// markdown (default)
				body = isHtml ? htmlToMarkdown(rawText) : rawText;
			}

			// Обрезаем
			const truncation = truncateHead(body, {
				maxBytes: WEB_FETCH_MAX_BYTES,
				maxLines: 2000,
			});

			let result = truncation.content;
			if (truncation.truncated) {
				result +=
					`\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}. ` +
					`Use bash with curl for full content.]`;
			}

			return {
				content: [{ type: "text" as const, text: result }],
				details: {
					url,
					format,
					contentType,
					truncated: truncation.truncated,
					bytes: truncation.outputBytes,
				},
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
			const d = result.details as
				| { url: string; format: string; truncated: boolean; bytes: number }
				| undefined;

			if (!d) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text.slice(0, 120) : "", 0, 0);
			}

			const size = formatSize(d.bytes);
			const trunc = d.truncated ? theme.fg("warning", " (truncated)") : "";
			return new Text(
				theme.fg("success", "✓ ") +
					theme.fg("dim", `${d.format} · ${size}`) +
					trunc,
				0,
				0,
			);
		},
	});

	// ── 2. TODO ──────────────────────────────────────────────────────────────

	const TodoParams = Type.Object({
		action: StringEnum(["list", "add", "done", "toggle", "clear"] as const, {
			description: "list — show all; add — create new (requires text); done — mark complete (requires id); toggle — toggle completion status (requires id); clear — remove all",
		}),
		text: Type.Optional(Type.String({ description: 'Task text (required for action="add")' })),
		id: Type.Optional(Type.Number({ description: 'Task ID (required for action="done" or "toggle")' })),
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			'Manages a persistent todo list. Actions: list — show all tasks; add (text) — create new task; done (id) — mark as complete; toggle (id) — toggle completion status; clear — remove all tasks.',
		promptSnippet: "Manage a persistent todo list across the session",
		promptGuidelines: [
			"Use todo to track multi-step tasks and show progress to the user.",
			"Call todo list at the start of a session to check for existing tasks.",
			"Use todo add to break down complex requests into actionable steps.",
			"Mark tasks as done when completed; use toggle if you need to undo a completion.",
		],
		parameters: TodoParams,

		async execute(_id, params) {
			switch (params.action) {
				case "list": {
					const text =
						todos.length > 0
							? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
							: "No tasks";
					return {
						content: [{ type: "text" as const, text }],
						details: { action: "list", todos: [...todos], nextId: nextTodoId } as TodoDetails,
					};
				}

				case "add": {
					if (!params.text) throw new Error("Parameter 'text' is required for action=add");
					const t: Todo = { id: nextTodoId++, text: params.text, done: false };
					todos.push(t);
					return {
						content: [{ type: "text" as const, text: `Added #${t.id}: ${t.text}` }],
						details: { action: "add", todos: [...todos], nextId: nextTodoId } as TodoDetails,
					};
				}

				case "done": {
					if (params.id === undefined) throw new Error("Parameter 'id' is required for action=done");
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) throw new Error(`Task #${params.id} not found`);
					todo.done = true;
					return {
						content: [{ type: "text" as const, text: `Task #${todo.id} completed ✓` }],
						details: { action: "done", todos: [...todos], nextId: nextTodoId } as TodoDetails,
					};
				}

				case "toggle": {
					if (params.id === undefined) throw new Error("Parameter 'id' is required for action=toggle");
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) throw new Error(`Task #${params.id} not found`);
					todo.done = !todo.done;
					return {
						content: [{ type: "text" as const, text: `Task #${todo.id} ${todo.done ? "completed" : "reopened"} ✓` }],
						details: { action: "toggle", todos: [...todos], nextId: nextTodoId } as TodoDetails,
					};
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextTodoId = 1;
					return {
						content: [{ type: "text" as const, text: `Cleared ${count} tasks` }],
						details: { action: "clear", todos: [], nextId: 1 } as TodoDetails,
					};
				}
			}
		},

		renderCall(args, theme) {
			let text =
				theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
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

			if (d.error) return new Text(theme.fg("error", `Error: ${d.error}`), 0, 0);

			const list = d.todos;

			switch (d.action) {
				case "list": {
					if (list.length === 0) return new Text(theme.fg("dim", "No tasks"), 0, 0);
					const done = list.filter((t) => t.done).length;
					let txt = theme.fg("muted", `${done}/${list.length} done:`);
					const show = expanded ? list : list.slice(0, 5);
					for (const t of show) {
						const check = t.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
						const label = t.done ? theme.fg("dim", t.text) : theme.fg("muted", t.text);
						txt += `\n${check} ${theme.fg("accent", `#${t.id}`)} ${label}`;
					}
					if (!expanded && list.length > 5)
						txt += `\n${theme.fg("dim", `... ${list.length - 5} more`)}`;
					return new Text(txt, 0, 0);
				}

				case "add": {
					const added = list[list.length - 1];
					return new Text(
						theme.fg("success", "✓ Added ") +
							theme.fg("accent", `#${added?.id}`) +
							" " +
							theme.fg("muted", added?.text ?? ""),
						0,
						0,
					);
				}

				case "done": {
					const t = result.content[0];
					const msg = t?.type === "text" ? t.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}

				case "toggle": {
					const t = result.content[0];
					const msg = t?.type === "text" ? t.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}

				case "clear":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "List cleared"), 0, 0);
			}
		},
	});

	// Command /todos — shows task list in TUI panel
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

	// ── 3. ASK_USER ──────────────────────────────────────────────────────────

	const AskUserParams = Type.Object({
		question: Type.String({ description: "Question to ask the user" }),
		options: Type.Optional(
			Type.Array(Type.String(), {
				description: "Answer options. If not provided, free-form input field is shown",
			}),
		),
	});

	interface AskDetails {
		question: string;
		options: string[];
		answer: string | null;
		wasCustom?: boolean;
	}

	pi.registerTool({
		name: "ask_user",
		label: "AskUser",
		description:
			"Asks the user a question and waits for their response. Use when you need clarification before proceeding. " +
			"You can provide answer options or leave it as free-form input.",
		promptSnippet:
			"Ask the user a question and wait for their answer before proceeding",
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
					details: { question: params.question, options: params.options ?? [], answer: null } as AskDetails,
				};
			}

			const options = params.options ?? [];
			const hasOptions = options.length > 0;

			// Mode: option list + "Write manually"
			if (hasOptions) {
				const allOpts = [...options, "✏️  Write manually..."];

				const result = await ctx.ui.custom<{ answer: string; wasCustom: boolean } | null>(
					(tui, theme, _kb, done) => {
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
							if (v) {
								done({ answer: v, wasCustom: true });
							} else {
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
							if (matchesKey(data, Key.escape)) { done(null); }
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
					},
				);

				if (!result) {
					return {
						content: [{ type: "text" as const, text: "User cancelled the selection" }],
						details: { question: params.question, options, answer: null } as AskDetails,
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text: result.wasCustom
								? `User wrote: ${result.answer}`
								: `User selected: ${result.answer}`,
						},
					],
					details: {
						question: params.question,
						options,
						answer: result.answer,
						wasCustom: result.wasCustom,
					} as AskDetails,
				};
			}

			// Mode: free-form input without options
			const answer = await ctx.ui.input(params.question);
			if (answer === undefined || answer === null) {
				return {
					content: [{ type: "text" as const, text: "User cancelled input" }],
					details: { question: params.question, options: [], answer: null } as AskDetails,
				};
			}
			return {
				content: [{ type: "text" as const, text: `User answered: ${answer}` }],
				details: { question: params.question, options: [], answer } as AskDetails,
			};
		},

		renderCall(args, theme) {
			let text =
				theme.fg("toolTitle", theme.bold("ask_user ")) +
				theme.fg("muted", args.question ?? "");
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
			if (d.answer === null) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const prefix = d.wasCustom
				? theme.fg("muted", "(wrote) ")
				: theme.fg("muted", "(selected) ");
			return new Text(
				theme.fg("success", "✓ ") + prefix + theme.fg("accent", d.answer),
				0,
				0,
			);
		},
	});
}
