/**
 * agent-defs.ts — Agent definition parsing utilities
 *
 * Reusable functions for loading and parsing Agent definitions from Markdown files.
 * Provides the same parsing logic used by agent-team and agent-chain.
 *
 * Standard format for an agent (.md):
 *   ---
 *   name: my-agent
 *   description: A short description of what it does
 *   tools: read,grep,bash
 *   ---
 *   System prompt goes here...
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface AgentDef {
	name: string;
	description: string;
	tools: string;
	systemPrompt: string;
	file: string;
}

/**
 * Format an agent name for display (e.g. "code-reviewer" -> "Code Reviewer").
 */
export function displayName(name: string): string {
	return name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * Parse an agent definition from a Markdown file with frontmatter.
 */
export function parseAgentFile(filePath: string): AgentDef | null {
	try {
		const raw = readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
		const match = raw.match(/^\s*---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!match) return null;

		const frontmatter: Record<string, string> = {};
		for (const line of match[1].split("\n")) {
			const idx = line.indexOf(":");
			if (idx > 0) {
				frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
			}
		}

		if (!frontmatter.name) return null;

		return {
			name: frontmatter.name,
			description: frontmatter.description || "",
			tools: frontmatter.tools || "read,grep,find,ls",
			systemPrompt: match[2].trim(),
			file: filePath,
		};
	} catch {
		return null;
	}
}

/**
 * Scan standard directories for agent definitions (.md files).
 * Standard dirs: <cwd>/agents/, <cwd>/.claude/agents/, <cwd>/.pi/agents/
 *
 * @param cwd Project root directory
 * @returns Array of valid AgentDefs found, deduplicated by name
 */
export function scanAgentDirs(cwd: string): AgentDef[] {
	const dirs = [
		join(cwd, "agents"),
		join(cwd, ".claude", "agents"),
		join(cwd, ".pi", "agents"),
	];

	const agents: AgentDef[] = [];
	const seen = new Set<string>();

	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".md")) continue;
				const fullPath = resolve(dir, file);
				const def = parseAgentFile(fullPath);
				if (def && !seen.has(def.name.toLowerCase())) {
					seen.add(def.name.toLowerCase());
					agents.push(def);
				}
			}
		} catch {}
	}

	return agents;
}
