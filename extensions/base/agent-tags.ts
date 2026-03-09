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

/**
 * Tag -> additional tools mapping.
 *
 * IMPORTANT: Keep this file in sync with extensions/base/base-tools.ts.
 */
export const TAG_TOOLS: Record<string, string[]> = {
	Wr: ["edit", "write", "apply_patch"],
	FS: ["edit", "write", "apply_patch"],
	Web: ["web_fetch"],
	Bash: ["bash", "script_run"],
	Agents: ["agent_spawn", "agent_join", "agent_continue", "agent_list", "agent_wait_any", "agent_wait_all"],
	Task: ["task"],
	UI: ["ask_user", "todo"],
};

/**
 * Resolves comma-separated tags to full tool list (BASE_TOOLS + tag tools).
 *
 * Tags:
 *   FS/Wr  — edit, write, apply_patch
 *   Web    — web_fetch
 *   Bash   — bash, script_run
 *   Agents — agent_spawn, agent_join, agent_continue, agent_list, agent_wait_any, agent_wait_all
 *   Task   — task (disposable one-shot sub-agent)
 *   UI     — ask_user, todo (only useful in orchestrator with hasUI)
 *
 * @param tags - Comma-separated tag names (e.g. "Wr,Web,Bash")
 * @returns Sorted array of tool names; BASE_TOOLS are always included
 */
export function resolveTagsToTools(tags: string): string[] {
	const set = new Set<string>(BASE_TOOLS);
	for (const tag of tags.split(",").map((t) => t.trim()).filter(Boolean)) {
		for (const t of TAG_TOOLS[tag] || []) set.add(t);
	}
	return [...set].sort();
}

/**
 * Returns true if any tool in the list comes from base-tools extension.
 *
 * @param toolNames - Array of tool names to check
 * @returns True if web_fetch, glob, task, script_run, apply_patch, ask_user, or todo is in the list
 */
export function toolsNeedBaseTools(toolNames: string[]): boolean {
	const ext = ["web_fetch", "glob", "task", "script_run", "apply_patch", "ask_user", "todo"];
	return toolNames.some((t) => ext.includes(t));
}

/**
 * Returns true if any tool in the list comes from base-agents extension.
 *
 * @param toolNames - Array of tool names to check
 * @returns True if any agent_spawn/join/continue/list/wait tool is in the list
 */
export function toolsNeedBaseAgents(toolNames: string[]): boolean {
	const ext = ["agent_spawn", "agent_join", "agent_continue", "agent_list", "agent_wait_any", "agent_wait_all"];
	return toolNames.some((t) => ext.includes(t));
}

/**
 * Filters tool list to only Pi built-in tools (for --tools CLI flag).
 *
 * @param toolNames - Full list of tool names (may include extension tools)
 * @returns Only read, write, edit, bash, grep, find, ls
 */
export function getBuiltinTools(toolNames: string[]): string[] {
	return toolNames.filter((t) => BUILTIN_TOOL_NAMES.includes(t));
}
