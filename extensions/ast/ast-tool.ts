/**
 * ast-tool.ts — AST Search Tool for Pi
 *
 * Searches code files using tree-sitter AST query patterns (S-expression format).
 * Thin wrapper over `npx tree-sitter query` — no compilation needed.
 *
 * Usage:
 *   import { registerAstTool } from "./ast-tool.ts";
 *   registerAstTool(pi);
 *
 * Parameters:
 *   - pattern: string (required) — S-expression query pattern
 *   - path: string (optional) — file or directory to search (default: cwd)
 *   - lang: string (optional) — language hint (typescript, python, rust, go…)
 *
 * Returns:
 *   Array of { file, line, column, text } matches
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { existsSync, statSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { invalidArgument, notFound, conciseDetails } from "../base/tool-contract.ts";

// ── Constants ──────────────────────────────────────────────────────────

const AST_TIMEOUT_MS = 60_000;
const MAX_MATCHES = 500;
const PREVIEW_MATCHES = 10;

// ── Schema ─────────────────────────────────────────────────────────────

export const AstSearchParams = Type.Object({
	pattern: Type.String({
		description:
			"Tree-sitter query pattern in S-expression format, e.g. (function_definition name: (identifier) @name)",
	}),
	path: Type.Optional(Type.String({ description: "File or directory to search (default: current directory)" })),
	lang: Type.Optional(Type.String({
		description:
			'Language hint. Determines which file extensions to search. Examples: typescript, python, rust, go, javascript, java, cpp, ruby. Auto-detected from file extension if omitted.',
	})),
});

export interface AstMatch {
	file: string;
	line: number;
	column: number;
	text: string;
}

export interface AstSearchDetails {
	pattern: string;
	searchPath: string;
	lang?: string;
	matchCount: number;
	filesSearched: number;
	matches: AstMatch[];
	truncated: boolean;
	elapsed: number;
	parseErrors: number;
	error?: string;
}

// ── Language → extensions mapping ──────────────────────────────────────

const LANG_EXTENSIONS: Record<string, string[]> = {
	typescript: [".ts", ".tsx", ".mts"],
	javascript: [".js", ".jsx", ".mjs", ".cjs"],
	python: [".py"],
	rust: [".rs"],
	go: [".go"],
	c: [".c", ".h"],
	cpp: [".cpp", ".hpp", ".cc", ".hh", ".cxx", ".hxx"],
	java: [".java"],
	ruby: [".rb"],
	php: [".php"],
	swift: [".swift"],
	kotlin: [".kt", ".kts"],
	scala: [".scala"],
	elixir: [".ex", ".exs"],
	haskell: [".hs"],
	zig: [".zig"],
	bash: [".sh"],
	json: [".json"],
	css: [".css"],
	html: [".html", ".htm"],
};

function extsForLang(lang?: string): string[] {
	if (!lang) return [".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go"];
	return LANG_EXTENSIONS[lang.toLowerCase()] ?? [`.${lang}`];
}

// ── File discovery ────────────────────────────────────────────────────

function collectFiles(root: string, exts: string[]): string[] {
	const results: string[] = [];
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop()!;
		let entries: string[];
		try { entries = readdirSync(dir); } catch { continue; }
		for (const e of entries) {
			if (e === "node_modules" || e === ".git" || e.startsWith(".")) continue;
			const full = join(dir, e);
			try {
				const s = statSync(full);
				if (s.isDirectory()) stack.push(full);
				else if (s.isFile() && exts.some(x => e.endsWith(x))) results.push(full);
			} catch { /* skip */ }
		}
	}
	return results.sort();
}

// ── Shell helper ──────────────────────────────────────────────────────

function runCmd(
	cmd: string, args: string[], cwd: string, timeout: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return new Promise(r => {
		const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: false, env: { ...process.env } });
		let out = "", err = "", done = false;
		const finish = (code: number) => { if (!done) { done = true; clearTimeout(tid); r({ exitCode: code, stdout: out, stderr: err }); } };
		const tid = setTimeout(() => { try { p.kill("SIGTERM"); } catch {} setTimeout(() => { try { p.kill("SIGKILL"); } catch {} finish(-1); }, 2000); }, timeout);
		p.stdout?.setEncoding("utf-8"); p.stdout?.on("data", (c: string) => out += c);
		p.stderr?.setEncoding("utf-8"); p.stderr?.on("data", (c: string) => err += c);
		p.on("close", c => finish(c ?? -1));
		p.on("error", e => { err += e.message; finish(-1); });
	});
}

// ── Parse tree-sitter query JSON output ──────────────────────────────

function parseMatches(raw: string): AstMatch[] {
	const results: AstMatch[] = [];
	// tree-sitter query outputs a JSON array of matches
	let data: any[];
	try { data = JSON.parse(raw); } catch { return results; }
	if (!Array.isArray(data)) return results;
	for (const match of data) {
		if (!match?.captures) continue;
		for (const cap of match.captures) {
			const n = cap.node;
			if (!n?.startPosition) continue;
			results.push({
				file: "",
				line: n.startPosition.row + 1,
				column: n.startPosition.column + 1,
				text: n.text ?? "",
			});
		}
	}
	return results;
}

// ── Tool Registration ────────────────────────────────────────────────

export function registerAstTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ast_search",
		label: "AST Search",
		description:
			"Search code files using tree-sitter AST query patterns (S-expression format). " +
			"Example: (function_definition name: (identifier) @name). " +
			"Uses `npx tree-sitter query` under the hood — no compilation or build step required.",
		parameters: AstSearchParams,

		async execute(_id, params, signal, _onUpdate, ctx) {
			const pattern = params.pattern?.trim();
			if (!pattern) {
				return invalidArgument("pattern is required", "Provide a tree-sitter query pattern, e.g. (function_definition name: (identifier) @name)").toToolResult();
			}

			const searchPath = params.path ? resolve(ctx.cwd, params.path) : ctx.cwd;
			if (!existsSync(searchPath)) {
				return notFound(`Path not found: ${searchPath}`, "Provide a valid file or directory path").toToolResult();
			}

			const start = Date.now();

			// Collect files
			const stat = statSync(searchPath);
			const files: string[] = stat.isFile()
				? [searchPath]
				: collectFiles(searchPath, extsForLang(params.lang));

			if (files.length === 0) {
				return {
					content: [{ type: "text", text: "No matching files found." }],
					details: conciseDetails("No files to search", {
						pattern, searchPath, lang: params.lang, matchCount: 0, filesSearched: 0, matches: [], truncated: false, elapsed: 0, parseErrors: 0,
					} as AstSearchDetails),
				};
			}

			// Write query to temp file
			const tmpDir = mkdtempSync(join(tmpdir(), "pi-ast-"));
			const queryFile = join(tmpDir, "query.scm");
			writeFileSync(queryFile, pattern, "utf-8");

			const allMatches: AstMatch[] = [];
			let filesSearched = 0;
			let parseErrors = 0;
			let lastError: string | undefined;

			try {
				for (const file of files) {
					if (signal?.aborted) break;
					if (allMatches.length >= MAX_MATCHES) break;

					const result = await runCmd("npx", ["tree-sitter", "query", queryFile, file], ctx.cwd, AST_TIMEOUT_MS);
					filesSearched++;

					if (result.exitCode !== 0) {
						const msg = (result.stderr || result.stdout || "").trim();
						if (msg) lastError = msg;
						parseErrors++;
						continue;
					}

					if (!result.stdout.trim()) continue;

					const fileMatches = parseMatches(result.stdout);
					const rel = relative(ctx.cwd, file);
					for (const m of fileMatches) m.file = rel;
					allMatches.push(...fileMatches);
				}
			} finally {
				try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
			}

			const elapsed = Date.now() - start;
			const truncated = allMatches.length > MAX_MATCHES;
			const matches = truncated ? allMatches.slice(0, MAX_MATCHES) : allMatches;

			const details: AstSearchDetails = {
				pattern, searchPath, lang: params.lang,
				matchCount: allMatches.length, filesSearched, matches, truncated,
				elapsed, parseErrors, error: lastError,
			};

			const outputText = matches.length > 0
				? matches.map(m => `${m.file}:${m.line}:${m.column} — ${m.text}`).join("\n")
				: "No matches found.";

			return {
				content: [{ type: "text", text: outputText }],
				details: conciseDetails(
					`${matches.length} match${matches.length !== 1 ? "es" : ""} in ${filesSearched} file${filesSearched !== 1 ? "s" : ""}`,
					details as unknown as Record<string, unknown>,
				),
			};
		},

		renderCall(args, theme) {
			const preview = (args.pattern || "").slice(0, 55);
			return new Text(theme.fg("toolTitle", "ast_search ") + theme.fg("accent", preview), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const d = result.details as AstSearchDetails | undefined;
			if (!d) return new Text(theme.fg("error", "✗ ast_search"), 0, 0);

			const icon = theme.fg("success", "✓ ");

			if (expanded && d.matches.length > 0) {
				const lines = [
					icon + theme.fg("toolTitle", "ast_search") + theme.fg("dim", ` ${d.matchCount} matches in ${d.filesSearched} files`),
					...d.matches.slice(0, PREVIEW_MATCHES).map(m =>
						theme.fg("muted", `  ${m.file}:${m.line}:${m.column} `) + theme.fg("text", m.text.slice(0, 80)),
					),
				];
				if (d.matches.length > PREVIEW_MATCHES) {
					lines.push(theme.fg("dim", `  … and ${d.matches.length - PREVIEW_MATCHES} more`));
				}
				if (d.error) lines.push(theme.fg("warning", `  ⚠ ${d.error.slice(0, 100)}`));
				return new Text(lines.join("\n"), 0, 0);
			}

			let text = icon + theme.fg("toolTitle", "ast_search ") + theme.fg("dim", `${d.matchCount} matches · ${d.filesSearched} files · ${Math.round(d.elapsed / 1000)}s`);
			if (d.parseErrors > 0) text += theme.fg("warning", ` · ${d.parseErrors} errors`);
			return new Text(text, 0, 0);
		},
	});
}
