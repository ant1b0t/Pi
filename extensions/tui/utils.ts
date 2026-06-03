// ============================================================================
// TUI utility functions
// ============================================================================

import { SPINNER_FRAMES, TREE, type RenderState, STATE_ICONS } from "./types";

/**
 * Get spinner frame for a given tick (monotonic counter).
 * Frame rate: advances every 80ms.
 */
export function getSpinnerFrame(): number {
	return Math.floor(Date.now() / 80) % SPINNER_FRAMES.length;
}

/**
 * Get status icon with optional spinner animation.
 */
export function statusIcon(state: RenderState, spinnerTick?: number): string {
	if (state === "running" && spinnerTick !== undefined) {
		return SPINNER_FRAMES[spinnerTick % SPINNER_FRAMES.length]!;
	}
	return STATE_ICONS[state];
}

/**
 * Format duration in human-readable form.
 */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return `${m}m ${s % 60}s`;
}

/**
 * ANSI escape sequence builder.
 */
export const ANSI = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	italic: "\x1b[3m",
	underline: "\x1b[4m",
	fg: (code: number) => `\x1b[38;5;${code}m`,
	bg: (code: number) => `\x1b[48;5;${code}m`,
	rgb: (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`,
	bgRgb: (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`,
};

/** Standard ANSI color codes. */
export const COLORS = {
	green: ANSI.fg(42),
	red: ANSI.fg(196),
	yellow: ANSI.fg(220),
	blue: ANSI.fg(33),
	cyan: ANSI.fg(51),
	magenta: ANSI.fg(201),
	grey: ANSI.fg(244),
	darkGrey: ANSI.fg(238),
	white: ANSI.fg(255),
} as const;

/**
 * Tree branch prefix for an item at given depth + position.
 */
export function treeBranch(isLast: boolean, depth: number): string {
	if (depth === 0) {
		return isLast ? TREE.last : TREE.branch;
	}
	// deeper levels use continue prefixes
	return isLast ? TREE.last : TREE.branch;
}

export function treePrefix(isLast: boolean, depth: number): string {
	let prefix = "";
	for (let i = 0; i < depth; i++) {
		prefix += "│  ";
	}
	prefix += treeBranch(isLast, depth);
	return prefix;
}

/**
 * Render a progress bar.
 * Example: [████████░░] 80%
 */
export function renderProgressBar(opts: {
	current: number;
	total: number;
	width?: number;
	filledChar?: string;
	emptyChar?: string;
	showPercent?: boolean;
	showFraction?: boolean;
}): string {
	const {
		current,
		total,
		width = 20,
		filledChar = "█",
		emptyChar = "░",
		showPercent = true,
		showFraction = false,
	} = opts;

	const clamped = Math.max(0, Math.min(current, total));
	const ratio = total > 0 ? clamped / total : 0;
	const filled = Math.round(ratio * width);
	const empty = width - filled;

	const bar = filledChar.repeat(filled) + emptyChar.repeat(empty);
	const parts = [`[${bar}]`];

	if (showPercent) {
		parts.push(` ${Math.round(ratio * 100)}%`);
	}
	if (showFraction) {
		parts.push(` (${clamped}/${total})`);
	}

	return parts.join("");
}

export function treeList(items: string[], options?: { maxCollapsed?: number; itemType?: string }): string[] {
	const max = options?.maxCollapsed ?? 20;
	const itemType = options?.itemType ?? "item";
	const visible = items.slice(0, max);
	const remaining = items.length - max;

	const lines = visible.map((item, i) => {
		const isLast = remaining <= 0 && i === visible.length - 1;
		const prefix = isLast ? TREE.last : TREE.branch;
		return ` ${prefix} ${item}`;
	});

	if (remaining > 0) {
		lines.push(` ${TREE.last} ...and ${remaining} more ${itemType}s`);
	}

	return lines;
}

/**
 * Wrap text with an OSC 8 hyperlink.
 */
export function hyperlink(url: string, label: string): string {
	return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}
