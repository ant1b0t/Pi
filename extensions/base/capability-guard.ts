/**
 * capability-guard.ts - Tool restriction for sub-agents by capability tags
 *
 * Core function: Blocks tool calls not in PI_AGENT_ALLOWED_TOOLS env
 * Key dependencies: Reads env, tool_call event, before_agent_start
 * Usage: Loaded in sub-agents; main agent has no restrictions when env unset
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	ALLOWED_TOOLS_ENV,
	buildCapabilityRestrictionPrompt,
	buildCapabilityRestrictionReason,
	parseAllowedToolsEnv,
} from "./allowed-tools.ts";

export default function capabilityGuard(pi: ExtensionAPI) {
	let allowedTools = new Set<string>();

	pi.on("session_start", async (_event, _ctx) => {
		allowedTools = parseAllowedToolsEnv(process.env[ALLOWED_TOOLS_ENV]);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (allowedTools.size === 0) return { block: false };

		if (!allowedTools.has(event.toolName)) {
			ctx.abort();
			return {
				block: true,
				reason: buildCapabilityRestrictionReason(event.toolName, allowedTools),
			};
		}
		return { block: false };
	});

	pi.on("before_agent_start", async (event) => {
		if (allowedTools.size === 0) return undefined;
		return {
			systemPrompt: event.systemPrompt + "\n\n" + buildCapabilityRestrictionPrompt(allowedTools),
		};
	});
}
