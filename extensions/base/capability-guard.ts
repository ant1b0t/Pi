/**
 * capability-guard.ts - Tool restriction for sub-agents by capability tags
 *
 * Core function: Blocks tool calls not in PI_AGENT_ALLOWED_TOOLS env
 * Key dependencies: Reads env, tool_call event, before_agent_start
 * Usage: Loaded in sub-agents; main agent has no restrictions when env unset
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { BASE_TOOLS, TAG_TOOLS } from "./agent-tags.ts";

const ENV_KEY = "PI_AGENT_ALLOWED_TOOLS";

/**
 * Accept normal tool identifiers while still rejecting malformed env payloads.
 * This keeps custom extension tools usable in restricted sub-agents.
 */
const KNOWN_TOOL_NAMES = new Set<string>([
	...BASE_TOOLS,
	...Object.values(TAG_TOOLS).flat(),
]);

function isValidToolName(name: string): boolean {
	return KNOWN_TOOL_NAMES.has(name) || /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name);
}

export default function capabilityGuard(pi: ExtensionAPI) {
	let allowedTools = new Set<string>();

	pi.on("session_start", async (_event, _ctx) => {
		const raw = process.env[ENV_KEY];
		if (raw && raw.trim()) {
			const parsed = raw.split(",").map((t) => t.trim()).filter(Boolean);
			allowedTools = new Set(parsed.filter((t) => isValidToolName(t)));
		} else {
			allowedTools = new Set();
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (allowedTools.size === 0) return { block: false };

		if (!allowedTools.has(event.toolName)) {
			const list = [...allowedTools].sort().join(", ");
			ctx.abort();
			return {
				block: true,
				reason: `Tool "${event.toolName}" is not available in this agent. Available: ${list}. Do not retry.`,
			};
		}
		return { block: false };
	});

	pi.on("before_agent_start", async (event) => {
		if (allowedTools.size === 0) return undefined;

		const sortedTools = [...allowedTools].sort();
		const hasBash = allowedTools.has("bash");
		const lines: string[] = [
			"## Capability restriction",
			`You have access only to: ${sortedTools.join(", ")}. Do not attempt to use other tools.`,
		];

		lines.push("");
		lines.push("## Operational hints");
		lines.push("- If you already know you need multiple files or search results, request all of them in a single response (bundle independent lookups).");
		if (hasBash) {
			lines.push("- For repetitive mechanical changes (bulk rename, mass replace, log filtering) use bash/python instead of individual edit calls. Check diff/tests after.");
		}
		lines.push("- When the next step depends on the current result, proceed sequentially — do not batch blindly.");

		lines.push("");
		lines.push("## Sub-agent Protocol (Final Delivery)");
		lines.push("Before completing your task, you MUST write a final message to the Orchestrator.");
		lines.push("- **TL;DR:** One sentence outcome.");
		lines.push("- **Payload:** The exact code snippets, paths, or data found.");
		lines.push("- **No Yapping:** NEVER list the tools you used or files you read. Do not say \"I used grep to...\". Just give the raw answer.");
		lines.push("");

		return {
			systemPrompt: event.systemPrompt + "\n\n" + lines.join("\n"),
		};
	});
}
