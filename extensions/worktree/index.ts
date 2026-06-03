/**
 * worktree — Git Worktree Tool Extension for Pi
 *
 * Creates an isolated git worktree, runs a command inside it,
 * returns the result, then removes the worktree.
 *
 * Usage:
 *   pi -e extensions/worktree/index.ts
 *
 * Or alongside base tools:
 *   pi -e extensions/worktree/index.ts -e extensions/base/base-tools.ts
 *
 * Tool:
 *   worktree — run a command in an isolated git worktree copy
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerWorktreeTool } from "./worktree-tool.ts";

export { registerWorktreeTool, WorktreeParams } from "./worktree-tool.ts";

export default function worktreeExtension(pi: ExtensionAPI) {
	registerWorktreeTool(pi);

	// Log that the extension loaded
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.notify("🌲 Worktree Tool loaded — isolated git worktree execution", "info");
	});
}
