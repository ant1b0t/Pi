// ============================================================================
// TUI components — адаптировано из oh-my-pi coding-agent TUI
//
// Предоставляет унифицированные компоненты для рендеринга в Pi-расширениях:
// - statusHeader: заголовок с иконкой статуса, описанием, метаданными
// - fileList: список файлов с иконками языков/директорий
// - diffBlock: блок diff с +/- подсветкой
// - resultsSummary: итоговая строка (N matches, M files, Xs)
// ============================================================================

import {
	statusIcon,
	formatDuration,
	renderProgressBar,
	treeList,
	COLORS,
	ANSI,
} from "./utils";
import type { RenderState } from "./types";

// ============================================================================
// Status Header
// ============================================================================

export interface StatusHeaderOpts {
	icon?: RenderState;
	spinnerTick?: number;
	title: string;
	description?: string;
	badge?: { label: string };
	meta?: string[];
}

/**
 * Standardized status header for tool output.
 * Example: ✓ ast_search: 10 matches · 3 files · 2s
 */
export function renderStatusHeader(opts: StatusHeaderOpts): string {
	const parts: string[] = [];

	if (opts.icon) {
		const icon = statusIcon(opts.icon, opts.spinnerTick);
		const color =
			opts.icon === "completed"
				? COLORS.green
				: opts.icon === "failed"
					? COLORS.red
					: opts.icon === "running"
						? COLORS.cyan
						: COLORS.grey;
		parts.push(`${color}${icon}${ANSI.reset}`);
	}

	parts.push(`${ANSI.bold}${opts.title}${ANSI.reset}`);

	if (opts.description) {
		parts.push(`${COLORS.grey}${opts.description}${ANSI.reset}`);
	}

	if (opts.badge) {
		parts.push(`${COLORS.blue}[${opts.badge.label}]${ANSI.reset}`);
	}

	if (opts.meta && opts.meta.length > 0) {
		parts.push(`${ANSI.dim}${opts.meta.join(" · ")}${ANSI.reset}`);
	}

	return parts.join(" ");
}

// ============================================================================
// Progress
// ============================================================================

export interface ProgressOpts {
	current: number;
	total: number;
	label?: string;
	width?: number;
}

/**
 * Render a progress bar with optional label.
 */
export function renderProgress(opts: ProgressOpts): string {
	const label = opts.label ? `${opts.label} ` : "";
	return label + renderProgressBar({
		current: opts.current,
		total: opts.total,
		width: opts.width ?? 20,
		showPercent: true,
	});
}

// ============================================================================
// File List
// ============================================================================

export interface FileEntry {
	path: string;
	isDirectory?: boolean;
	meta?: string;
}

/** Map extension → icon. */
const FILE_ICONS: Record<string, string> = {
	ts: "🔷",
	tsx: "⚛️",
	js: "🟨",
	jsx: "⚛️",
	json: "📋",
	yaml: "📝",
	yml: "📝",
	md: "📄",
	rs: "🦀",
	py: "🐍",
	go: "🔵",
	sh: "⚡",
	toml: "⚙️",
	css: "🎨",
	html: "🌐",
	gitignore: "🙈",
};

function extIcon(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return FILE_ICONS[ext] ?? "📄";
}

/**
 * Render a file listing with icons.
 */
export function renderFileList(files: FileEntry[], options?: { maxCollapsed?: number }): string[] {
	if (files.length === 0) return [`${COLORS.grey}(no files)${ANSI.reset}`];

	return treeList(
		files.map(f => {
			const icon = f.isDirectory ? "📁" : extIcon(f.path);
			const meta = f.meta ? ` ${ANSI.dim}${f.meta}${ANSI.reset}` : "";
			return `${icon} ${f.path}${meta}`;
		}),
		{ maxCollapsed: options?.maxCollapsed ?? 30, itemType: "file" },
	);
}

// ============================================================================
// Diff Block
// ============================================================================

/**
 * Highlight a unified diff block with +/- coloring.
 * Green for additions, red for deletions, cyan for hunk headers.
 */
export function renderDiff(diffText: string, options?: { maxLines?: number }): string[] {
	const lines = diffText.split("\n");
	const maxLines = options?.maxLines ?? 50;
	const visible = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;

	const result = visible.map(line => {
		if (line.startsWith("+")) return `${COLORS.green}${line}${ANSI.reset}`;
		if (line.startsWith("-")) return `${COLORS.red}${line}${ANSI.reset}`;
		if (line.startsWith("@@")) return `${COLORS.cyan}${line}${ANSI.reset}`;
		if (line.startsWith("diff ")) return `${ANSI.bold}${line}${ANSI.reset}`;
		return `${COLORS.darkGrey}${line}${ANSI.reset}`;
	});

	if (remaining > 0) {
		result.push(`${ANSI.dim}… ${remaining} more lines${ANSI.reset}`);
	}

	return result;
}

// ============================================================================
// Results Summary
// ============================================================================

export interface ResultsSummaryOpts {
	matchCount: number;
	filesSearched?: number;
	elapsedMs: number;
	truncated?: boolean;
	parseErrors?: number;
	totalLines?: number;
}

/**
 * Compact results summary line.
 * Example: ✓ 42 matches in 8 files · 1.2s · 3 parse errors
 */
export function renderResultsSummary(opts: ResultsSummaryOpts): string {
	const parts: string[] = [];

	parts.push(`${COLORS.green}${opts.matchCount} match${opts.matchCount !== 1 ? "es" : ""}${ANSI.reset}`);

	if (opts.filesSearched !== undefined) {
		parts.push(`in ${opts.filesSearched} file${opts.filesSearched !== 1 ? "s" : ""}`);
	}

	parts.push(`${ANSI.dim}·${ANSI.reset}`);
	parts.push(`${ANSI.dim}${formatDuration(opts.elapsedMs)}${ANSI.reset}`);

	if (opts.parseErrors && opts.parseErrors > 0) {
		parts.push(`${ANSI.dim}·${ANSI.reset}`);
		parts.push(`${COLORS.yellow}${opts.parseErrors} error${opts.parseErrors !== 1 ? "s" : ""}${ANSI.reset}`);
	}

	if (opts.truncated) {
		parts.push(`${ANSI.dim}(truncated)${ANSI.reset}`);
	}

	if (opts.totalLines !== undefined) {
		parts.push(`${ANSI.dim}·${ANSI.reset}`);
		parts.push(`${ANSI.dim}${opts.totalLines} lines${ANSI.reset}`);
	}

	return parts.join(" ");
}

// ============================================================================
// Section
// ============================================================================

/**
 * Render a labeled section with optional collapsible content.
 */
export function renderSection(
	label: string,
	lines: string[],
	options?: { maxCollapsed?: number; emptyMessage?: string },
): string[] {
	const result: string[] = [];
	result.push(`${ANSI.bold}${COLORS.cyan}${label}${ANSI.reset}`);
	if (lines.length === 0) {
		result.push(`  ${COLORS.grey}${options?.emptyMessage ?? "(empty)"}${ANSI.reset}`);
		return result;
	}
	const max = options?.maxCollapsed ?? 20;
	const visible = lines.slice(0, max);
	for (const line of visible) {
		result.push(`  ${line}`);
	}
	if (lines.length > max) {
		result.push(`  ${ANSI.dim}… ${lines.length - max} more lines${ANSI.reset}`);
	}
	return result;
}
