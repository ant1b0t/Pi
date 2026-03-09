/**
 * capability-guard.ts - Tool restriction for sub-agents by capability tags
 *
 * Core function: Blocks tool calls not in PI_AGENT_ALLOWED_TOOLS env
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

	pi.on("session_start", async () => {
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
				reason: `Tool "${event.toolName}" is not available in this sub-agent. Available: ${list}. Do not retry this blocked tool.`,
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
			`You have access only to these tools: ${sortedTools.join(", ")}. Do not attempt to call any other tools.`,
			"",
			"## Operational hints",
			"- Bundle independent lookups into one response when possible.",
			"- If a needed tool is unavailable, do not retry it; adapt your plan to the available tools.",
		];

		if (hasBash) {
			lines.push("- For repetitive mechanical work, prefer bash over many tiny manual edits.");
		}

		lines.push(
			"",
			"## Sub-agent delivery protocol",
			"Before finishing, send a concise final answer back to the orchestrator:",
			"- TL;DR: one-sentence outcome.",
			"- Payload: exact findings, paths, snippets, or results.",
			"- Do not narrate tool usage or say which files you read unless that is itself the requested output.",
		);

		return {
			systemPrompt: event.systemPrompt + "\n\n" + lines.join("\n"),
		};
	});
}
