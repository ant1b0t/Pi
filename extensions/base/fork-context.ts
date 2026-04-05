import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export type AgentSpawnMode = "fresh" | "fork";
export type ForkContextMode = "none" | "recent";

export function normalizeSpawnMode(value?: string): AgentSpawnMode {
	return value === "fork" ? "fork" : "fresh";
}

export function normalizeForkContextMode(value?: string): ForkContextMode {
	return value === "recent" ? "recent" : "none";
}

export function formatBranchEntryForFork(entry: any): string {
	if (!entry || entry.type !== "message" || !entry.message) return "";
	const msg = entry.message;
	const role = String(msg.role || "assistant");
	const content = msg.content;
	let text = "";
	if (typeof content === "string") {
		text = content;
	} else if (Array.isArray(content)) {
		text = content.map((part: any) => {
			if (part.type === "text") return part.text || "";
			if (part.type === "toolCall") return `Tool: ${part.name}(${JSON.stringify(part.arguments || {}).slice(0, 200)})`;
			return "";
		}).filter(Boolean).join("\n");
	}
	text = String(text || "").trim();
	if (!text) return "";
	const label = role === "user" ? "User" : role === "toolResult" ? `Tool ${msg.toolName || "result"}` : "Assistant";
	return `### ${label}\n${text}`;
}

export function buildForkContextPrompt(ctx: ExtensionContext, options: {
	mode: AgentSpawnMode;
	contextMode: ForkContextMode;
	turns?: number;
	maxChars?: number;
}): string {
	if (options.mode !== "fork" || options.contextMode === "none") return "";
	const branch = ctx.sessionManager.getBranch();
	const turns = Math.min(12, Math.max(1, Math.floor(options.turns ?? 6)));
	const maxChars = Math.min(20000, Math.max(1000, Math.floor(options.maxChars ?? 12000)));
	const recentEntries = branch.filter((entry: any) => entry?.type === "message").slice(-(turns * 2));
	const blocks: string[] = [];
	let used = 0;
	for (const entry of recentEntries) {
		const block = formatBranchEntryForFork(entry);
		if (!block) continue;
		const candidate = `${block}\n\n`;
		if (used + candidate.length > maxChars) break;
		blocks.push(block);
		used += candidate.length;
	}
	if (blocks.length === 0) return "";
	return [
		"## Forked parent context",
		"The following recent conversation context was inherited from the parent agent. Use it only as working context for this delegated task.",
		"Do not assume omitted context is irrelevant; if something is missing, say so explicitly.",
		"",
		...blocks,
		"",
	].join("\n");
}
