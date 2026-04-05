/**
 * agent-tags.ts - Tag-to-tools mapping for sub-agent capability control
 *
 * Core function: Resolves capability tags to tool lists for agent_spawn
 * Key dependencies: Used by base-agents for spawn/continue
 * Usage: resolveTagsToTools("Wr,Web") -> BASE_TOOLS + edit, write, web_fetch
 */

const BUILTIN_TOOL_NAMES = ["read", "write", "edit", "bash", "grep", "find", "ls"];

/** Base tools always available to every agent (read-only codebase access). */
export const BASE_TOOLS = ["read", "grep", "find", "ls", "glob"];

export interface TagDefinition {
	tag: string;
	tools: string[];
	description: string;
	enabled?: boolean;
	advertised?: boolean;
}

/** Structured tag registry. Keep this as the source of truth for tag metadata. */
export const TAGS: Readonly<Record<string, TagDefinition>> = {
	Wr: {
		tag: "Wr",
		tools: ["edit", "write", "apply_patch"],
		description: "edit, write, apply_patch",
		enabled: true,
		advertised: true,
	},
	Web: {
		tag: "Web",
		tools: ["web_fetch"],
		description: "web_fetch",
		enabled: true,
		advertised: true,
	},
	Bash: {
		tag: "Bash",
		tools: ["bash", "script_run"],
		description: "bash, script_run",
		enabled: true,
		advertised: true,
	},
	Agents: {
		tag: "Agents",
		tools: ["agent_spawn", "agent_join", "agent_result", "agent_continue", "agent_list"],
		description: "agent_spawn, agent_join, agent_result, agent_continue, agent_list",
		enabled: true,
		advertised: true,
	},
	Task: {
		tag: "Task",
		tools: ["task"],
		description: "task (disposable one-shot sub-agent)",
		enabled: true,
		advertised: true,
	},
	UI: {
		tag: "UI",
		tools: ["ask_user", "todo"],
		description: "ask_user, todo",
		enabled: true,
		advertised: true,
	},
};

/** Tag -> additional tools mapping. Tags are additive. */
export const TAG_TOOLS: Record<string, string[]> = Object.fromEntries(
	Object.entries(TAGS)
		.filter(([, def]) => def.enabled !== false)
		.map(([tag, def]) => [tag, [...def.tools]]),
);

export const ALL_TAG_NAMES = Object.keys(TAGS);
export const ADVERTISED_TAG_NAMES = ALL_TAG_NAMES.filter((tag) => TAGS[tag]?.advertised !== false && TAGS[tag]?.enabled !== false);
export const ADVERTISED_TAGS_DESCRIPTION = ADVERTISED_TAG_NAMES
	.map((tag) => `${tag}=${TAGS[tag]?.description}`)
	.join("; ");

const EXTENSION_TOOLSETS = {
	baseTools: new Set(["web_fetch", "glob", "task", "script_run", "apply_patch", "ask_user", "todo"]),
	baseAgents: new Set(["agent_spawn", "agent_join", "agent_result", "agent_continue", "agent_list", "agent_wait_any", "agent_wait_all"]),
};

export function parseTags(tags?: string | string[]): string[] {
	const raw = Array.isArray(tags) ? tags.join(",") : (tags || "");
	return raw.split(",").map((t) => t.trim()).filter(Boolean);
}

export function validateTags(tags?: string | string[]): { valid: string[]; invalid: string[] } {
	const parsed = parseTags(tags);
	const valid: string[] = [];
	const invalid: string[] = [];
	for (const tag of parsed) {
		if (TAGS[tag]?.enabled === false || !TAGS[tag]) invalid.push(tag);
		else valid.push(tag);
	}
	return {
		valid: Array.from(new Set(valid)),
		invalid: Array.from(new Set(invalid)),
	};
}

export function getTagDefinition(tag: string): TagDefinition | undefined {
	return TAGS[tag];
}

export function getAdvertisedTags(): string[] {
	return [...ADVERTISED_TAG_NAMES];
}

/**
 * Resolves comma-separated tags to full tool list (BASE_TOOLS + tag tools).
 * Unknown/disabled tags are ignored here for backwards compatibility.
 * Use validateTags() when you need explicit validation.
 */
export function resolveTagsToTools(tags: string): string[] {
	const set = new Set<string>(BASE_TOOLS);
	for (const tag of parseTags(tags)) {
		for (const t of TAG_TOOLS[tag] || []) set.add(t);
	}
	return [...set];
}

/**
 * Returns true if any tool in the list comes from base-tools extension.
 */
export function toolsNeedBaseTools(toolNames: string[]): boolean {
	return toolNames.some((t) => EXTENSION_TOOLSETS.baseTools.has(t));
}

/**
 * Returns true if any tool in the list comes from base-agents extension.
 */
export function toolsNeedBaseAgents(toolNames: string[]): boolean {
	return toolNames.some((t) => EXTENSION_TOOLSETS.baseAgents.has(t));
}

export function getKnownToolNames(): string[] {
	const set = new Set<string>([...BASE_TOOLS]);
	for (const def of Object.values(TAGS)) {
		for (const tool of def.tools) set.add(tool);
	}
	for (const tool of EXTENSION_TOOLSETS.baseAgents) set.add(tool);
	return [...set].sort();
}

/**
 * Filters tool list to only Pi built-in tools (for --tools CLI flag).
 */
export function getBuiltinTools(toolNames: string[]): string[] {
	return toolNames.filter((t) => BUILTIN_TOOL_NAMES.includes(t));
}
