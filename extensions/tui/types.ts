// ============================================================================
// TUI types shared across components
// ============================================================================

/** Visual state for rendering. */
export type RenderState = "pending" | "running" | "warning" | "completed" | "failed";

/** Icons per render state. */
export const STATE_ICONS: Record<RenderState, string> = {
	pending: "○",
	running: "◌",
	warning: "⚠",
	completed: "✓",
	failed: "✗",
};

/** Spinner frames for running state. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Tree branch characters. */
export const TREE = {
	branch: "├──",
	last: "└──",
	continue: "│  ",
	spacer: "   ",
} as const;

export interface TreeContext {
	index: number;
	isLast: boolean;
	depth: number;
}

export interface ProgressBarOptions {
	current: number;
	total: number;
	width: number;
	label?: string;
	state?: RenderState;
	filledChar?: string;
	emptyChar?: string;
}
