/**
 * agent-events.ts — Event parsing and session file utilities
 *
 * Pure functions for:
 *   - Parsing JSON events from Pi subprocess stdout
 *   - Extracting structured terminal results from agents
 *   - Reading and parsing JSONL session files into HistoryItem[]
 *
 * No Pi API dependency — import from any agent extension.
 *
 * Key exports:
 *   parseAgentEvent              — update mutable state from one stdout event
 *   extractTerminalResult        — walk messages[] → AgentTerminalResult
 *   extractTerminalResultFromFile — session file fallback for agent_join
 *   parseSessionFile             — JSONL → HistoryItem[] (for chat overlay)
 *   getTextFromContent           — extract ALL text blocks from Pi content array
 *   getElapsedTime               — Date diff → "12s" / "3m 4s"
 */

import { existsSync, readFileSync } from "node:fs";

// ── Types ──────────────────────────────────────────────────────────────

export interface HistoryItem {
	type: "user" | "assistant" | "tool";
	title: string;
	content: string;
	timestamp: Date;
	elapsed?: string;
}

/**
 * Structured terminal result from a completed sub-agent run.
 *
 * kind:
 *  "text"      — agent produced a final text answer
 *  "error"     — agent finished with an API/model error (no final text)
 *  "tool-only" — agent completed via tools but wrote no final summary
 *  "empty"     — truly nothing: no text, no error, no tool trace
 */
export interface AgentTerminalResult {
	kind: "text" | "error" | "tool-only" | "empty";
	/** Final text answer (kind === "text") */
	text?: string;
	/** Last API/model error message (kind === "error") */
	error?: string;
	/** True when at least one tool result exists in the session */
	hasToolResults?: boolean;
}

/**
 * Minimal state interface required by parseAgentEvent.
 * SubAgentState in base-agents.ts satisfies this automatically.
 */
export interface MutableAgentState {
	turnCount: number;
	toolCount: number;
	lastAssistantText: string;
	lastErrorMessage: string;
	/** Streaming text accumulator — cleared on message_end */
	currentStreamText: string;
	lastTool?: { name: string; args: string };
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Extract ALL text blocks from a Pi message content array and join them.
 * Previously only the first block was returned — that loses content when
 * a message has text / toolCall / text interleaved.
 */
export function getTextFromContent(content: any): string {
	if (!content || !Array.isArray(content)) return "";
	return content
		.filter((p: any) => p.type === "text" && p.text)
		.map((p: any) => p.text as string)
		.join("");
}

/**
 * Extract the last assistant text from an array of AgentMessage objects.
 * Searches from the end — returns the most recent message with text.
 */
export function extractLastAssistantText(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const text = getTextFromContent(msg.content);
			if (text) return text;
		}
	}
	return "";
}

/** Format elapsed time between two Dates: "12s" or "3m 4s". */
export function getElapsedTime(start: Date, end: Date): string {
	const diffMs = end.getTime() - start.getTime();
	const diffSec = Math.floor(diffMs / 1000);
	if (diffSec < 60) return `${diffSec}s`;
	const diffMin = Math.floor(diffSec / 60);
	return `${diffMin}m ${diffSec % 60}s`;
}

/**
 * Extract text content from a JSONL session message entry.
 * Handles text, toolCall, and raw string content.
 */
export function extractMessageContent(entry: any): string {
	const msg = entry.message;
	if (!msg) return "";
	const content = msg.content;
	if (!content) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c: any) => {
				if (c.type === "text") return c.text || "";
				if (c.type === "toolCall") return `Tool: ${c.name}(${JSON.stringify(c.arguments || {}).slice(0, 200)})`;
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return JSON.stringify(content).slice(0, 500);
}

// ── Terminal result extraction ─────────────────────────────────────────

/**
 * Derive a structured terminal result from an array of AgentMessage objects
 * (e.g. from agent_end event or built from session).
 *
 * Priority:
 *  1. Last assistant message that contains text
 *  2. Last assistant errorMessage
 *  3. Any tool results present → "tool-only"
 *  4. "empty"
 */
export function extractTerminalResult(messages: any[]): AgentTerminalResult {
	let lastError = "";
	let hasToolResults = false;
	let hasToolCalls = false;

	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg) continue;

		if (msg.role === "toolResult") hasToolResults = true;

		if (msg.role === "assistant") {
			// Check for text first
			const text = getTextFromContent(msg.content);
			if (text) return { kind: "text", text, hasToolResults };

			// Check for tool calls (tool-only pattern)
			if (Array.isArray(msg.content)) {
				for (const p of msg.content) {
					if (p.type === "toolCall") { hasToolCalls = true; break; }
				}
			}

			// Check for error message
			if (msg.errorMessage && !lastError) {
				lastError = msg.errorMessage as string;
			}
		}
	}

	if (lastError) return { kind: "error", error: lastError, hasToolResults };
	if (hasToolResults || hasToolCalls) return { kind: "tool-only", hasToolResults };
	return { kind: "empty" };
}

/**
 * Extract a terminal result from a JSONL session file.
 * Used as fallback when stdout events did not populate state.
 */
export function extractTerminalResultFromFile(sessionPath: string): AgentTerminalResult {
	if (!existsSync(sessionPath)) return { kind: "empty" };
	let raw: string;
	try {
		raw = readFileSync(sessionPath, "utf-8");
	} catch {
		return { kind: "empty" };
	}

	const lines = raw.split("\n").filter((l) => l.trim());
	const messages: any[] = [];

	for (const line of lines) {
		try {
			const entry = JSON.parse(line);
			if (entry.type === "message" && entry.message) {
				messages.push(entry.message);
			}
		} catch {
			// skip malformed lines
		}
	}

	return extractTerminalResult(messages);
}

/**
 * Backwards-compat: extract last assistant text from session file.
 * Prefer extractTerminalResultFromFile() for new code.
 */
export function extractLastAssistantTextFromSessionFile(sessionPath: string): string {
	const result = extractTerminalResultFromFile(sessionPath);
	return result.kind === "text" ? (result.text ?? "") : "";
}

// ── Session file parsing ───────────────────────────────────────────────

/**
 * Parse a sub-agent session JSONL file into HistoryItem array.
 * Used by the sub-agent chat overlay and session replay.
 */
export function parseSessionFile(sessionPath: string): HistoryItem[] {
	if (!existsSync(sessionPath)) return [];
	let raw: string;
	try {
		raw = readFileSync(sessionPath, "utf-8");
	} catch {
		return [];
	}
	const items: HistoryItem[] = [];
	let prevTime: Date | null = null;

	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (!msg) continue;

			const ts = msg.timestamp ? new Date(msg.timestamp) : new Date(entry.timestamp || 0);
			const elapsed = prevTime ? getElapsedTime(prevTime, ts) : undefined;
			prevTime = ts;

			const role = msg.role;
			const text = extractMessageContent(entry);
			if (!text) continue;

			if (role === "user") {
				items.push({ type: "user", title: "User", content: text, timestamp: ts, elapsed });
			} else if (role === "assistant") {
				items.push({ type: "assistant", title: "Assistant", content: text, timestamp: ts, elapsed });
			} else if (role === "toolResult") {
				const toolName = (msg as any).toolName || "tool";
				items.push({ type: "tool", title: `Tool: ${toolName}`, content: text, timestamp: ts, elapsed });
			}
		} catch {
			// skip malformed lines
		}
	}
	return items;
}

// ── Event parsing ──────────────────────────────────────────────────────

/**
 * Parse a single JSON event from sub-agent stdout and update mutable agent state.
 *
 * Handles:
 *  - message_update → accumulate streaming text deltas
 *  - message_end    → finalize turn text + tool counts
 *  - tool_execution_start → track current tool
 *  - agent_end      → extract final result from full message list
 *
 * @param ev    Parsed JSON event object from subprocess stdout
 * @param state Any object satisfying MutableAgentState
 */
export function parseAgentEvent(ev: any, state: MutableAgentState): void {
	// ── Streaming text accumulation ──────────────────────────────────
	if (ev.type === "message_update") {
		const delta = ev.assistantMessageEvent;
		if (delta?.type === "text_delta" && typeof delta.delta === "string") {
			state.currentStreamText += delta.delta;
		}
		return;
	}

	// ── message_end: finalize the turn ──────────────────────────────
	if (ev.type === "message_end") {
		const msg = ev.message;
		if (msg?.role === "assistant") {
			state.turnCount++;

			// Prefer accumulated stream text, fall back to content array
			const streamText = state.currentStreamText.trim();
			const contentText = getTextFromContent(msg.content);
			const finalText = streamText || contentText;
			if (finalText) state.lastAssistantText = finalText;

			// Capture error message if present
			if (msg.errorMessage) state.lastErrorMessage = msg.errorMessage as string;

			// Count tool calls
			for (const p of (msg.content || [])) {
				if (p.type === "toolCall") {
					state.toolCount++;
					state.lastTool = { name: p.name, args: JSON.stringify(p.arguments || {}) };
				}
			}
		}
		state.currentStreamText = "";
		return;
	}

	// ── tool_execution_start: track current tool ─────────────────────
	if (ev.type === "tool_execution_start") {
		state.lastTool = { name: ev.toolName, args: JSON.stringify(ev.args || {}) };
		return;
	}

	// ── agent_end: authoritative final state ─────────────────────────
	if (ev.type === "agent_end") {
		const result = extractTerminalResult(ev.messages || []);
		if (result.kind === "text" && result.text) {
			state.lastAssistantText = result.text;
		} else if (result.kind === "error" && result.error) {
			state.lastErrorMessage = result.error;
		}
	}
}
