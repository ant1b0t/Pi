/**
 * lsp-tool.ts — LSP Tool for Pi
 *
 * Spawns language servers via npx, communicates over JSON-RPC stdio,
 * and exposes LSP operations: diagnostics, definition, references, hover, symbols.
 *
 * Clients are cached per (cwd, serverType) — one process reused across calls.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawn, ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { invalidArgument, notFound, internalError, conciseDetails } from "../base/tool-contract.ts";

// ── Types ─────────────────────────────────────────────────────────────

type ServerType = "typescript" | "python" | "rust";

interface PendingCall {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;

// ── Server commands ───────────────────────────────────────────────────

const SERVER_CMD: Record<ServerType, { cmd: string; args: string[]; langId: string }> = {
	typescript: { cmd: "npx", args: ["typescript-language-server", "--stdio"], langId: "typescript" },
	python: { cmd: "npx", args: ["pyright-langserver", "--stdio"], langId: "python" },
	rust: { cmd: "npx", args: ["rust-analyzer"], langId: "rust" },
};

function detectServerType(file: string): ServerType | null {
	if (/\.(ts|tsx|mts|cts)$/i.test(file)) return "typescript";
	if (/\.py$/i.test(file)) return "python";
	if (/\.rs$/i.test(file)) return "rust";
	return null;
}

// ── LSP Client ────────────────────────────────────────────────────────

class LspClient {
	private proc: ChildProcess;
	private idCounter = 0;
	private pending = new Map<number | string, PendingCall>();
	private buffer = "";
	private diagnostics = new Map<string, unknown[]>();
	private initPromise: Promise<void>;
	crashed = false;

	constructor(serverType: ServerType, cwd: string) {
		const { cmd, args } = SERVER_CMD[serverType];
		const rootUri = `file://${cwd}`;

		this.proc = spawn(cmd, args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});

		this.proc.stdout!.setEncoding("utf-8");
		this.proc.stdout!.on("data", (chunk: string) => this.onData(chunk));

		this.proc.stderr!.on("data", () => {
			// LSP servers log to stderr; ignore for clean output
		});

		this.proc.on("close", (code) => {
			this.crashed = true;
			const err = new Error(`LSP server exited with code ${code}`);
			for (const [, p] of this.pending) p.reject(err);
			this.pending.clear();
		});

		this.proc.on("error", (err) => {
			this.crashed = true;
			for (const [, p] of this.pending) p.reject(err);
			this.pending.clear();
		});

		// Collect diagnostics by URI
		this.onNotification("textDocument/publishDiagnostics", (params: any) => {
			this.diagnostics.set(params.uri, params.diagnostics || []);
		});

		this.initPromise = this.handshake(rootUri);
	}

	// ── JSON-RPC framing ───────────────────────────────────────────

	private onData(chunk: string) {
		this.buffer += chunk;
		while (true) {
			const m = this.buffer.match(/Content-Length: (\d+)\r\n\r\n/);
			if (!m || m.index === undefined) break;
			const len = parseInt(m[1], 10);
			const bodyStart = m.index + m[0].length;
			if (this.buffer.length < bodyStart + len) break;
			const body = this.buffer.slice(bodyStart, bodyStart + len);
			this.buffer = this.buffer.slice(bodyStart + len);
			try {
				this.dispatch(JSON.parse(body));
			} catch {
				/* skip malformed messages */
			}
		}
	}

	private dispatch(msg: any) {
		if (msg.method !== undefined) {
			// Notification (no id) or server→client request (has id, rare — ignore)
			const fn = this._notifiers.get(msg.method);
			if (fn && msg.id === undefined) fn(msg.params);
		} else if (msg.id !== undefined) {
			const p = this.pending.get(msg.id);
			if (p) {
				this.pending.delete(msg.id);
				clearTimeout(p.timeout);
				if (msg.error) p.reject(new Error(msg.error.message || "LSP error"));
				else p.resolve(msg.result);
			}
		}
	}

	private _notifiers = new Map<string, (params: any) => void>();

	onNotification(method: string, fn: (params: any) => void) {
		this._notifiers.set(method, fn);
	}

	send(msg: Record<string, unknown>) {
		if (this.crashed) throw new Error("LSP server has crashed");
		const json = JSON.stringify(msg);
		const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
		this.proc.stdin!.write(header + json);
	}

	request(method: string, params?: unknown): Promise<unknown> {
		return new Promise((resolvePromise, reject) => {
			const id = ++this.idCounter;
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`LSP request '${method}' timed out after ${REQUEST_TIMEOUT_MS}ms`));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, { resolve: resolvePromise, reject, timeout });
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params?: unknown) {
		this.send({ jsonrpc: "2.0", method, params });
	}

	// ── Lifecycle ──────────────────────────────────────────────────

	private async handshake(rootUri: string): Promise<void> {
		await this.request("initialize", {
			processId: process.pid,
			rootUri,
			capabilities: {
				textDocument: {
					hover: { contentFormat: ["markdown", "plaintext"] },
					definition: { linkSupport: true },
					references: {},
					documentSymbol: { hierarchicalDocumentSymbolSupport: true },
					diagnostic: { dynamicRegistration: true },
				},
				workspace: {
					diagnostic: { refreshSupport: false },
				},
			},
		});
		this.notify("initialized", {});
		// Wait for server readiness (some servers send window/workDoneProgress or similar)
		await new Promise((r) => setTimeout(r, 200));
	}

	// ── File operations ────────────────────────────────────────────

	private openFiles = new Set<string>();

	private async ensureOpen(filePath: string, langId: string): Promise<void> {
		const uri = uriFromFilePath(filePath);
		if (this.openFiles.has(uri)) {
			// File already open — send didChange to refresh
			const content = readFileSync(filePath, "utf-8");
			this.notify("textDocument/didChange", {
				textDocument: { uri, version: Date.now() },
				contentChanges: [{ text: content }],
			});
			return;
		}
		this.openFiles.add(uri);
		const content = readFileSync(filePath, "utf-8");
		this.notify("textDocument/didOpen", {
			textDocument: { uri, languageId: langId, version: 1, text: content },
		});
		// Wait for diagnostics to arrive
		await new Promise<void>((resolve) => {
			const start = Date.now();
			const check = () => {
				if (this.diagnostics.has(uri) || Date.now() - start > 5000) {
					resolve();
				} else {
					setTimeout(check, 100);
				}
			};
			check();
		});
	}

	private closeFile(filePath: string): void {
		const uri = uriFromFilePath(filePath);
		if (!this.openFiles.has(uri)) return;
		this.openFiles.delete(uri);
		try {
			this.notify("textDocument/didClose", { textDocument: { uri } });
		} catch {
			/* ignore if crashed */
		}
		// Clean up diagnostics for closed file
		this.diagnostics.delete(uri);
	}

	// ── Public API ─────────────────────────────────────────────────

	async diagnostics(filePath: string, langId: string): Promise<unknown[]> {
		const uri = uriFromFilePath(filePath);
		await this.ensureOpen(filePath, langId);
		const result = this.diagnostics.get(uri) || [];
		this.closeFile(filePath);
		return result;
	}

	async definition(filePath: string, langId: string, line: number, col: number) {
		const uri = uriFromFilePath(filePath);
		await this.ensureOpen(filePath, langId);
		const result = await this.request("textDocument/definition", {
			textDocument: { uri },
			position: { line: line - 1, character: col - 1 },
		});
		this.closeFile(filePath);
		return result;
	}

	async references(filePath: string, langId: string, line: number, col: number) {
		const uri = uriFromFilePath(filePath);
		await this.ensureOpen(filePath, langId);
		const result = await this.request("textDocument/references", {
			textDocument: { uri },
			position: { line: line - 1, character: col - 1 },
			context: { includeDeclaration: true },
		});
		this.closeFile(filePath);
		return result;
	}

	async hover(filePath: string, langId: string, line: number, col: number) {
		const uri = uriFromFilePath(filePath);
		await this.ensureOpen(filePath, langId);
		const result = await this.request("textDocument/hover", {
			textDocument: { uri },
			position: { line: line - 1, character: col - 1 },
		});
		this.closeFile(filePath);
		return result;
	}

	async symbols(filePath: string, langId: string) {
		const uri = uriFromFilePath(filePath);
		await this.ensureOpen(filePath, langId);
		const result = await this.request("textDocument/documentSymbol", { textDocument: { uri } });
		this.closeFile(filePath);
		return result;
	}

	async shutdown() {
		this.crashed = true;
		// Close all remaining open files
		for (const uri of [...this.openFiles]) {
			try { this.notify("textDocument/didClose", { textDocument: { uri } }); } catch { /* ignore */ }
			this.openFiles.delete(uri);
		}
		this.diagnostics.clear();
		try { await this.request("shutdown", {}); } catch { /* ignore */ }
		try { this.notify("exit", {}); } catch { /* ignore */ }
		try { this.proc.kill(); } catch { /* ignore */ }
		for (const [, p] of this.pending) clearTimeout(p.timeout);
		this.pending.clear();
	}

	dispose() {
		void this.shutdown();
	}
}

// ── Client cache ───────────────────────────────────────────────────────

const cache = new Map<string, LspClient>();

function getClient(serverType: ServerType, cwd: string): LspClient {
	const key = `${cwd}:${serverType}`;
	let client = cache.get(key);
	if (!client || client.crashed) {
		client?.dispose();
		client = new LspClient(serverType, cwd);
		cache.set(key, client);
	}
	return client;
}

/** Build a standards-compliant file:// URI from an absolute path. */
function uriFromFilePath(absolutePath: string): string {
	const parts = absolutePath.replace(/\\/g, "/").split("/");
	return "file://" + parts.map(encodeURIComponent).join("/");
}

// ── Schema ─────────────────────────────────────────────────────────────

export const LspParams = Type.Object({
	action: Type.String({
		description:
			"LSP action: 'diagnostics' | 'definition' | 'references' | 'hover' | 'symbols'",
	}),
	file: Type.String({
		description: "File path (absolute or relative to cwd)",
	}),
	line: Type.Optional(
		Type.Number({ description: "1-based line number (for definition, references, hover)" }),
	),
	column: Type.Optional(
		Type.Number({ description: "1-based column number (for definition, references, hover)" }),
	),
});

// ── Output formatting ──────────────────────────────────────────────────

function uriToPath(uri: string): string {
	return decodeURIComponent(uri.replace(/^file:\/\//, ""));
}

function fmtPos(uri: string, r: any): string {
	const line = (r?.start?.line ?? 0) + 1;
	const col = (r?.start?.character ?? 0) + 1;
	return `${uriToPath(uri)}:${line}:${col}`;
}

function fmtDiagnostics(diags: unknown[], file: string): string {
	const items = diags as any[];
	if (!items.length) return "No diagnostics found.";
	const sev: Record<number, string> = { 1: "ERROR", 2: "WARNING", 3: "INFO", 4: "HINT" };
	return items
		.map((d) => {
			const l = (d.range?.start?.line ?? 0) + 1;
			const c = (d.range?.start?.character ?? 0) + 1;
			return `${file}:${l}:${c} [${sev[d.severity] || "?"}] ${d.message}`;
		})
		.join("\n");
}

function fmtLocation(loc: unknown): string {
	if (!loc) return "Not found.";
	const arr = Array.isArray(loc) ? loc : [loc];
	return arr
		.map((l: any) => {
			const uri = l.uri || l.targetUri || "";
			const range = l.range || l.targetSelectionRange || l.targetRange || {};
			return fmtPos(uri, range);
		})
		.join("\n");
}

function fmtHover(h: unknown): string {
	if (!h) return "No hover information.";
	const hover = h as any;
	let text = "";
	const contents = hover.contents;
	if (typeof contents === "string") {
		text = contents;
	} else if (Array.isArray(contents)) {
		text = contents.map((c: any) => (typeof c === "string" ? c : c.value || "")).join("\n");
	} else if (contents?.value) {
		text = contents.language
			? `\`\`\`${contents.language}\n${contents.value}\n\`\`\``
			: contents.value;
	} else if (contents) {
		text = JSON.stringify(contents);
	}
	if (hover.range) {
		const line = (hover.range.start?.line ?? 0) + 1;
		const col = (hover.range.start?.character ?? 0) + 1;
		text = `at ${line}:${col}\n${text}`;
	}
	return text || "(empty hover)";
}

function fmtSymbols(syms: unknown, indent = ""): string {
	const items = syms as any[];
	if (!items?.length) return "No symbols found.";
	const kindMap: Record<number, string> = {
		1: "File", 2: "Module", 3: "Namespace", 5: "Class", 6: "Method",
		7: "Property", 8: "Field", 9: "Constructor", 11: "Interface",
		12: "Function", 13: "Variable", 14: "Constant", 23: "Struct", 25: "Enum",
	};
	const lines: string[] = [];
	for (const s of items) {
		const kind = kindMap[s.kind] || `kind:${s.kind}`;
		const line = (s.location?.range?.start?.line ?? s.range?.start?.line ?? 0) + 1;
		const col = (s.location?.range?.start?.character ?? s.range?.start?.character ?? 0) + 1;
		const detail = s.detail ? `: ${s.detail}` : "";
		lines.push(`${indent}${kind} ${s.name}${detail} — ${line}:${col}`);
		if (s.children) lines.push(fmtSymbols(s.children, indent + "  "));
	}
	return lines.join("\n");
}

// ── Tool registration ──────────────────────────────────────────────────

export function registerLspTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "lsp",
		label: "LSP",
		description:
			"Query a language server for diagnostics, go-to-definition, references, hover info, and document symbols. " +
			"Supports TypeScript/JavaScript (typescript-language-server), Python (pyright), and Rust (rust-analyzer). " +
			"Requires npx and the relevant server package installed.",
		parameters: LspParams,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const action = (params.action as string)?.trim().toLowerCase();
			const file = (params.file as string)?.trim();

			if (!action) return invalidArgument("action is required", "Provide: diagnostics, definition, references, hover, symbols").toToolResult();
			if (!file) return invalidArgument("file is required", "Provide a file path").toToolResult();

			const valid = new Set(["diagnostics", "definition", "references", "hover", "symbols"]);
			if (!valid.has(action)) {
				return invalidArgument(`Unknown action: ${action}`, `Valid: ${[...valid].join(", ")}`).toToolResult();
			}

			const filePath = resolve(ctx.cwd, file);
			if (!existsSync(filePath)) {
				return notFound(`File not found: ${filePath}`, "Check the file path").toToolResult();
			}

			const serverType = detectServerType(filePath);
			if (!serverType) {
				return invalidArgument(
					`Unsupported file type: ${filePath}`,
					"Supported: .ts/.tsx (TypeScript), .py (Python), .rs (Rust)",
				).toToolResult();
			}

			const needsPos = new Set(["definition", "references", "hover"]);
			const line = (params.line as number) || 1;
			const col = (params.column as number) || 1;
			if (needsPos.has(action) && params.line === undefined) {
				return invalidArgument(
					`action '${action}' requires line (and optionally column)`,
					"Provide line and column numbers (1-based)",
				).toToolResult();
			}

			const { langId } = SERVER_CMD[serverType];
			const start = Date.now();
			let result: string;

			try {
				const client = getClient(serverType, ctx.cwd);

				switch (action) {
					case "diagnostics":
						result = fmtDiagnostics(await client.diagnostics(filePath, langId), filePath);
						break;
					case "definition":
						result = fmtLocation(await client.definition(filePath, langId, line, col));
						break;
					case "references":
						result = fmtLocation(await client.references(filePath, langId, line, col));
						break;
					case "hover":
						result = fmtHover(await client.hover(filePath, langId, line, col));
						break;
					case "symbols":
						result = fmtSymbols(await client.symbols(filePath, langId));
						break;
					default:
						return internalError(`Unhandled action: ${action}`, "Report this bug").toToolResult();
				}
			} catch (err: any) {
				return internalError(
					`LSP ${action} failed: ${err.message || err}`,
					"Ensure the language server is available via npx (typescript-language-server / pyright-langserver / rust-analyzer). " +
						"First call may download the package.",
				).toToolResult();
			}

			const elapsed = Date.now() - start;
			const shortFile = filePath.split("/").pop() || filePath;

			return {
				content: [{ type: "text", text: result }],
				details: conciseDetails(`LSP ${action} on ${shortFile}`, {
					action,
					file: filePath,
					serverType,
					elapsed,
				} as Record<string, unknown>),
			};
		},

		renderCall(args, theme) {
			const a = ((args.action as string) || "?").slice(0, 14);
			const f = ((args.file as string) || "").split("/").pop() || "?";
			return new Text(theme.fg("toolTitle", "lsp ") + theme.fg("accent", `${a} ${f}`), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const d = result.details as any;
			if (!d) return new Text(theme.fg("error", "✗ lsp"), 0, 0);

			const icon = result.isError
				? theme.fg("error", "✗ ")
				: theme.fg("success", "✓ ");
			const file = d.file?.split?.("/")?.pop?.() || "";
			const sec = Math.round((d.elapsed || 0) / 1000);

			if (expanded) {
				return new Text(
					[
						icon + theme.fg("toolTitle", "lsp ") + theme.fg("dim", `${d.action} ${file}`),
						theme.fg("muted", `  server: ${d.serverType}  ⏱ ${sec}s`),
					].join("\n"),
					0,
					0,
				);
			}

			return new Text(
				icon + theme.fg("toolTitle", "lsp ") + theme.fg("dim", `${d.action} ${file} · ${sec}s`),
				0,
				0,
			);
		},
	});
}
