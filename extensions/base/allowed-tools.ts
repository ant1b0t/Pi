import { getKnownToolNames } from "./agent-tags.ts";

export const ALLOWED_TOOLS_ENV = "PI_AGENT_ALLOWED_TOOLS";

const KNOWN_TOOL_NAMES = new Set<string>(getKnownToolNames());

export function isValidToolName(name: string): boolean {
	return KNOWN_TOOL_NAMES.has(name) || /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name);
}

export function parseAllowedToolsEnv(raw?: string | null): Set<string> {
	if (!raw || !raw.trim()) return new Set<string>();
	return new Set(
		raw
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean)
			.filter((t) => isValidToolName(t)),
	);
}

export function buildAllowedToolsEnv(toolList: string[]): Record<string, string> {
	return { [ALLOWED_TOOLS_ENV]: toolList.join(",") };
}

export function buildCapabilityRestrictionPrompt(allowedTools: Set<string>): string {
	const sortedTools = [...allowedTools].sort();
	const hasBash = allowedTools.has("bash");
	const lines: string[] = [
		"## Capability restriction",
		`You have access only to: ${sortedTools.join(", ")}. Do not attempt to use other tools.`,
		"",
		"## Operational hints",
		"- If you already know you need multiple files or search results, request all of them in a single response (bundle independent lookups).",
	];

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
	return lines.join("\n");
}

export function buildCapabilityRestrictionReason(toolName: string, allowedTools: Set<string>): string {
	const list = [...allowedTools].sort().join(", ");
	return `Tool "${toolName}" is not available in this agent. Available: ${list}. Do not retry.`;
}
