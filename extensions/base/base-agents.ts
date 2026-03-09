/**
 * BaseAgents — Sub-Agent Orchestration for Pi
 *
 * Tools for the LLM:
 *   agent_spawn  — Launch a background agent, returns ID immediately
 *   agent_join   — Block until an agent finishes, return its output
 *   agent_list   — List all agents with their current status
 *
 * User commands:
 *   /agents       — Overlay showing all agents + their status
 *   /akill <id>   — Kill a running agent
 *   /aclear       — Remove all finished/errored agents from UI
 *
 * === INFRASTRUCTURE ===
 * Process spawning, session management, event parsing and output formatting
 * are provided by shared modules — import them directly in your own extensions:
 *
 *   import { spawnPiProcess, makeSessionFile, resolveExtensions } from "./agent-runner.ts";
 *   import { parseAgentEvent, parseSessionFile }                  from "./agent-events.ts";
 *
 * === KEY NOTES ===
 * Single shared timer: one setInterval updates ALL widgets simultaneously.
 * Per-agent timers caused Pi to reorder widgets (visual "jumping").
 *
 * agent_join timeout: 15-minute wall-clock limit.
 * Prevents the main agent being blocked forever if a subprocess hangs.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	Editor,
	Key,
	matchesKey,
	truncateToWidth,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { resolveTagsToTools } from "./agent-tags.ts";
import { parseAgentFile, scanAgentDirs, type AgentDef } from "./agent-defs.ts";
import {
	parseAgentEvent,
	parseSessionFile,
	extractTerminalResultFromFile,
	type HistoryItem,
} from "./agent-events.ts";
import {
	AGENT_JOIN_TIMEOUT_MS,
	AGENT_JOIN_POLL_INTERVAL_MS,
	AGENT_NOTIFICATION_DELAY_MS,
	MAX_FULL_OUTPUT,
	MAX_STDERR_LINES,
	SESSION_FILE_RETRY_ATTEMPTS,
	SESSION_FILE_RETRY_DELAY_MS,
	SIGKILL_DELAY_MS,
	WIDGET_UPDATE_INTERVAL_MS,
	canonicalizeToolList,
	cleanSessionDir,
	formatAgentOutputDetailed,
	killProcess,
	makeSessionFile,
	resolveExtensions,
	resolveToolsParam,
	scheduleForceKill,
	spawnPiProcess,
} from "./agent-runner.ts";
import { applyExtensionDefaults } from "./themeMap.ts";
import {
	loadModelTiers,
	resolveModel,
	reverseLookupTier,
	currentModelString,
	modelLabel,
	type ModelTier,
	type ModelTiers,
} from "./model-tiers.ts";

// ── Types ───────────────────────────────────────────────────────────────

interface SubAgentState {
	id: number;
	name: string;
	status: "running" | "done" | "error";
	/** Whether the final result was already retrieved via agent_join. */
	resultJoined: boolean;
	task: string;
	// lastAssistantText: text from the most recent assistant message (final answer)
	lastAssistantText: string;
	toolCount: number;
	turnCount: number;
	elapsed: number;
	startTime: number;
	sessionFile: string;  // Persistent session file for conversation continuation
	proc?: ChildProcess;
	killed: boolean;
	timedOut: boolean;
	lastTool?: { name: string; args: string };
	stderrLines: string[];
	/** Comma-separated tool list (for agent_continue to reuse). */
	tools: string;
	/** Original tags passed at spawn (e.g. "Bash,Web" or ["Bash", "Web"]), for display. */
	tags?: string | string[];
	/** Resolved model string used for this agent (e.g. "anthropic/claude-haiku-3-5"). */
	model?: string;
	/** Tier that was requested ("high" | "medium" | "low"), for display purposes. */
	tier?: ModelTier;
	/** Monotonic run sequence number. Incremented on spawn/continue. Used to match notifications to runs. */
	runSeq: number;
	/** Last error message from model or API (if kind === "error"). */
	lastErrorMessage: string;
	/** Accumulator for streaming text deltas. */
	currentStreamText: string;
	/** How to notify the main agent on completion. Default: "ui". */
	notifyMode?: "off" | "ui" | "turn";
	/** Optional appended system prompt for role-based sub-agents. */
	systemPrompt?: string;
	/** Optional source agent definition file path. */
	agentFile?: string;
	/** Timestamp of the latest visible activity for auto-focus in compact UI. */
	lastActivityAt: number;
}

// ── Schemas ────────────────────────────────────────────────────────────

const FormatEnum = Type.String({
	description: 'Output detail. Allowed: "summary only" | "full output"',
});

const TierEnum = Type.String({
	description: 'Model tier. Allowed: "high" | "medium" | "low". Omit to inherit parent model.',
});

const NotifyEnum = Type.String({
	description: 'Notification mode. Allowed: "off" | "ui" | "turn"',
});

const AgentSpawnParams = Type.Object({
	task: Type.String({ description: "Task description" }),
	name: Type.Optional(Type.String({ description: "Display name for the sub-agent (defaults to agent definition name or agent-<id>)" })),
	agent: Type.Optional(Type.String({ description: "Agent definition name from agents/, .claude/agents/, or .pi/agents/ (e.g. scout, builder, reviewer)" })),
	agentFile: Type.Optional(Type.String({ description: "Path to an agent definition markdown file. If provided, its system prompt and tools are loaded." })),
	systemPrompt: Type.Optional(Type.String({ description: "Extra system prompt for the sub-agent. Appended after any loaded agent definition prompt." })),
	tags: Type.Optional(Type.String({ description: "Capability tags as comma-separated string: Wr,Web,Bash,Agents,UI. Ignored for tools if agent/agentFile defines tools unless tags are explicitly provided as an override. (read, glob, grep, ls, find are ALWAYS included)" })),
	format: Type.Optional(FormatEnum),
	tier: Type.Optional(TierEnum),
	model: Type.Optional(Type.String({ description: "Explicit model string (overrides tier)" })),
	notify: Type.Optional(NotifyEnum),
});

const AgentJoinParams = Type.Object({
	id: Type.Number({ description: "Agent ID" }),
	format: Type.Optional(FormatEnum),
	artifact: Type.Optional(Type.Boolean({ description: "If true, save the full agent output to an artifact file and return a preview + absolute path." })),
});

const AgentContinueParams = Type.Object({
	id: Type.Number({ description: "Agent ID" }),
	prompt: Type.String({ description: "New instructions" }),
	tags: Type.Optional(Type.String({ description: "Capability tags as comma-separated string: Wr,Web,Bash,Agents,UI. (read, glob, grep, ls, find are ALWAYS included)" })),
	systemPrompt: Type.Optional(Type.String({ description: "Optional extra system prompt to append for future turns." })),
	format: Type.Optional(FormatEnum),
	tier: Type.Optional(TierEnum),
	model: Type.Optional(Type.String({ description: "Explicit model string (overrides tier)" })),
	notify: Type.Optional(NotifyEnum),
});

const AgentWaitParams = Type.Object({
	ids: Type.Optional(Type.Array(Type.Number(), { description: "Optional list of agent IDs to wait for. If omitted, waits for ALL running agents." })),
	timeoutMs: Type.Optional(Type.Number({ description: "Wait timeout in ms. Default: 15 min." })),
});

const AgentListParams = Type.Object({});

// ── Guidance injected into system prompt ──────────────────────────────
//
// Uses RISEN-style structure (Expectation + Narrowing) for orchestrator behavior.
// Without explicit completion criteria, agents over-deliver and scope-creep.
// See: RISEN framework, Ralph exit gates, declare_task_succeeded patterns.

const ORCHESTRATOR_GUIDANCE = `
## Sub-agent tools available to you
- Use agent_spawn to launch a background sub-agent. It returns an ID immediately.
- Use agent_join to wait for a specific sub-agent result.
- Use agent_continue to resume an existing sub-agent session with more instructions.
- Use agent_list to inspect current agent status.
- Use agent_wait_any / agent_wait_all to block on parallel work.
- CLI helpers: /agents, /aenter <id>, /akill <id>, /acont <id> <prompt>, /aclear

## Exact delegation rules
- When you decide to delegate, call the actual tool agent_spawn. Do not merely describe spawning conceptually.
- When you need an agent definition from .pi/agents, pass agent or agentFile to agent_spawn.
- When you need the result, call the actual tool agent_join or a wait tool.
- If a task has multiple independent parts, spawn multiple agents in parallel, then use agent_wait_all and/or agent_join.

## Model tiers
- high: STRICTLY for architecture design, complex planning, and deep algorithmic debugging. DO NOT use for code exploration or web research.
- medium: default for exploring codebases, web research, writing tests, and standard implementation.
- low: simple extraction, formatting, proofreading, and lightweight analysis.
- Omit tier to inherit the parent model.

## Orchestration best practices
- Delegation is mandatory for heavy parallelizable work.
- Keep tasks focused: one agent, one clear objective.
- Keep your own context clean; use sub-agents for bulky exploration.
- Do not rely on notifications to continue work; explicitly call agent_join / agent_wait_*.
- Do not leave finished agents unjoined if their work matters to the answer. After agent_wait_any / agent_wait_all, explicitly join every completed agent you intend to rely on.
- For long outputs, prefer agent_join with artifact:true.
- After compaction or uncertainty, call agent_list first.
- If agent_join reports no final output, do not hallucinate results.

## Final delivery rules
- Deliver one final synthesis to the user.
- Produce only what the user requested.
- Do not create artifacts unless asked.
`.trim();

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Renders the agent list overlay content (for /agents command).
 */
function renderAgentsListLines(
	agentList: SubAgentState[],
	selectedIndex: number,
	width: number,
	theme: { fg: (color: string, text: string) => string }
): string[] {
	const lines: string[] = [
		"",
		truncateToWidth(
			theme.fg("accent", "───") +
			theme.fg("accent", " Sub-Agents ") +
			theme.fg("accent", "─".repeat(Math.max(0, width - 15))),
			width
		),
		"",
	];

	if (agentList.length === 0) {
		lines.push(truncateToWidth("  " + theme.fg("dim", "No agents spawned yet."), width));
	} else {
		agentList.forEach((agent, idx) => {
			const isSelected = idx === selectedIndex;
			lines.push(...renderAgentBlock(agent, isSelected, width, theme, true));
			lines.push("");
		});
	}

	lines.push(truncateToWidth(
		"  " + theme.fg("dim", "↑/↓ = focus · Enter = chat · Esc / q = close"),
		width
	));
	lines.push("");
	return lines;
}

function normalizeMetaPart(part: unknown): string | undefined {
	if (typeof part === "string") {
		const trimmed = part.trim();
		return trimmed || undefined;
	}
	if (Array.isArray(part)) {
		const joined = part
			.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
			.join(", ");
		return joined || undefined;
	}
	return undefined;
}

function getAgentMetaParts(meta: {
	tier?: string;
	model?: string;
	tags?: string | string[];
}): string[] {
	return [meta.tier, modelLabel(meta.model), meta.tags]
		.map((part) => normalizeMetaPart(part))
		.filter((part): part is string => Boolean(part));
}

function formatAgentMetaInline(meta: {
	tier?: string;
	model?: string;
	tags?: string | string[];
}): string {
	return getAgentMetaParts(meta).join(" · ");
}

function formatAgentMetaBracketed(meta: {
	tier?: string;
	model?: string;
	tags?: string | string[];
}): string {
	return getAgentMetaParts(meta).map((part) => `[${part}]`).join(" ");
}

function formatElapsedShort(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.round(elapsedMs / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}`;
	const hours = Math.floor(minutes / 60);
	const remMinutes = minutes % 60;
	return `${hours}h${String(remMinutes).padStart(2, "0")}`;
}

function agentStatusColor(agent: SubAgentState): string {
	return agent.status === "running" ? "accent"
		: agent.status === "done" ? "success" : "error";
}

function agentStatusIcon(agent: SubAgentState): string {
	if (agent.status === "running") return "▶";
	if (agent.status === "done") return "✓";
	return agent.timedOut ? "⏱" : agent.killed ? "⊘" : "✗";
}

function agentStatusLabel(agent: SubAgentState): string {
	if (agent.status === "running") return "running";
	if (agent.timedOut) return "timed out";
	if (agent.killed) return "killed";
	if (agent.status === "done") return "done";
	return "error";
}

function agentJoinLabel(agent: SubAgentState): string | undefined {
	if (agent.status !== "done") return undefined;
	return agent.resultJoined ? "joined" : "awaiting join";
}

function summarizeTask(task: string, maxWidth: number): string {
	const clean = task.replace(/\s+/g, " ").trim();
	if (!clean) return "No task";
	return clean.length > maxWidth ? `${clean.slice(0, Math.max(1, maxWidth - 1))}…` : clean;
}

function summarizeLastTool(agent: SubAgentState, maxWidth: number): string {
	if (!agent.lastTool) return agent.status === "running" ? "starting…" : "idle";
	const args = summarizeTask(agent.lastTool.args, Math.max(12, maxWidth));
	return args && args !== "No task"
		? `${agent.lastTool.name} · ${args}`
		: agent.lastTool.name;
}

function renderAgentBlock(
	agent: SubAgentState,
	isFocused: boolean,
	width: number,
	theme: { fg: (color: string, text: string) => string },
	isOverlay = false
): string[] {
	const sc = agentStatusColor(agent);
	const icon = agentStatusIcon(agent);
	const statusStr = agent.status === "running" ? "running" : agentStatusLabel(agent);
	const time = formatElapsedShort(agent.elapsed);

	const basePad = "  "; // align away from terminal left edge
	const focusIndicator = isOverlay ? theme.fg("accent", "› ") : "";
	const noFocusIndicator = isOverlay ? "  " : "";

	if (!isFocused) {
		const action = agent.status === "running"
			? summarizeLastTool(agent, Math.max(18, Math.floor(width * 0.35)))
			: summarizeTask(agent.task, Math.max(18, Math.floor(width * 0.35)));
		const base = `${icon} #${agent.id} ${agent.name}`;
		const meta = formatAgentMetaInline({ tier: agent.tier, model: agent.model });
		const baseColor = agent.status === "done" ? "success" : "dim";
		const statusColor = agent.status === "done" ? "success" : sc;
		const joinLabel = agentJoinLabel(agent);
		let line = basePad + noFocusIndicator + theme.fg(baseColor, base) + theme.fg("dim", " · ") + theme.fg("muted", action) + theme.fg("dim", " · ") + theme.fg(statusColor, `${statusStr} (${time})`);
		if (joinLabel) line += theme.fg("dim", " · ") + theme.fg(agent.resultJoined ? "dim" : "success", joinLabel);
		if (meta) line += theme.fg("dim", ` · ${meta}`);
		return [truncateToWidth(line, width)];
	}

	const lines: string[] = [];
	const meta = formatAgentMetaInline(agent);
	const indent = basePad + noFocusIndicator + "  ";

	const header = basePad + focusIndicator + theme.fg(sc, `${icon} #${agent.id} ${agent.name}`) +
		theme.fg("dim", `  ${time} · ${agent.turnCount}t · ${agent.toolCount}⚒`) +
		(meta ? theme.fg("dim", ` · ${meta}`) : "");
	lines.push(truncateToWidth(header, width));

	lines.push(truncateToWidth(
		indent + theme.fg("dim", "task: ") + theme.fg("muted", summarizeTask(agent.task, width - 12)),
		width
	));

	let detail = summarizeLastTool(agent, width - 14);
	let detailPrefix = "run:  ";
	let detailColor = sc;
	
	if (agent.status === "done") {
		detailPrefix = "      ";
		detail = agent.resultJoined ? "✓ joined" : `✓ awaiting join · use agent_join(${agent.id})`;
		detailColor = "success";
	}
	else if (agent.timedOut) { detailPrefix = "      "; detail = "⏱ timed out (15 min limit)"; detailColor = "error"; }
	else if (agent.killed) { detailPrefix = "      "; detail = "⊘ killed by user"; detailColor = "warning"; }
	else if (agent.status === "error" && !agent.timedOut && !agent.killed) {
		detailPrefix = "err:  ";
		detail = agent.lastErrorMessage || agent.stderrLines[agent.stderrLines.length - 1] || "error";
		detail = summarizeTask(detail, width - 14);
		detailColor = "error";
	}

	lines.push(truncateToWidth(
		indent + theme.fg("dim", detailPrefix) + theme.fg(detailColor, detail),
		width
	));

	return lines;
}

function getFocusedAgentId(agentList: SubAgentState[]): number | undefined {
	const running = agentList.filter((agent) => agent.status === "running");
	const pool = running.length > 0 ? running : agentList;
	if (pool.length === 0) return undefined;
	return pool
		.slice()
		.sort((a, b) => (b.lastActivityAt || b.startTime || 0) - (a.lastActivityAt || a.startTime || 0))[0]
		?.id;
}

// ═══════════════════════════════════════════════════════════════════════
// EXTENSION
// ═══════════════════════════════════════════════════════════════════════

export default function baseAgents(pi: ExtensionAPI) {
	const globalKey = "__pi_vs_cc_base_agents_loaded__";
	if ((globalThis as Record<string, unknown>)[globalKey]) return;
	(globalThis as Record<string, unknown>)[globalKey] = true;

	const rawTools = process.env.PI_AGENT_ALLOWED_TOOLS;
	const allowedTools = rawTools ? new Set(rawTools.split(",").map(t => t.trim()).filter(Boolean)) : null;

	function isAllowed(name: string): boolean {
		if (!allowedTools) return true;
		return allowedTools.has(name);
	}

	const agents = new Map<number, SubAgentState>();
	/** runKey (id:runSeq) currently being waited on by agent_join. */
	const joinWaiters = new Set<string>();
	/** runKey (id:runSeq) for which result was already consumed. */
	const joinedRuns = new Set<string>();
	/** Pending notification timeouts (runKey -> timeout). */
	const pendingNotifications = new Map<string, ReturnType<typeof setTimeout>>();
	const completionWaiters = new Set<{
		ids: Set<number>;
		mode: "any" | "all";
		resolve: (text: string) => void;
	}>();
	let activeCtx: ExtensionContext | undefined;
	let modelTiers: ModelTiers | null = null;

	function runKey(id: number, runSeq: number): string {
		return `${id}:${runSeq}`;
	}

	function clearAgentState(id: number): void {
		const prefix = `${id}:`;
		for (const key of joinWaiters) if (key.startsWith(prefix)) joinWaiters.delete(key);
		for (const key of joinedRuns) if (key.startsWith(prefix)) joinedRuns.delete(key);
		for (const [key, tid] of pendingNotifications) {
			if (key.startsWith(prefix)) {
				clearTimeout(tid);
				pendingNotifications.delete(key);
			}
		}
		for (const waiter of Array.from(completionWaiters)) {
			waiter.ids.delete(id);
			if (waiter.ids.size === 0) completionWaiters.delete(waiter);
		}
	}

	function beginAgentRun(state: SubAgentState, prompt: string, notifyMode?: "off" | "ui" | "turn"): void {
		state.status = "running";
		state.resultJoined = false;
		state.task = prompt;
		state.lastAssistantText = "";
		state.lastErrorMessage = "";
		state.currentStreamText = "";
		state.toolCount = 0;
		state.turnCount++;
		state.elapsed = 0;
		state.startTime = Date.now();
		state.killed = false;
		state.timedOut = false;
		state.stderrLines = [];
		state.lastTool = undefined;
		state.runSeq++;
		state.notifyMode = notifyMode ?? state.notifyMode ?? "ui";
		state.lastActivityAt = Date.now();

		const previousKey = runKey(state.id, state.runSeq - 1);
		const previousTid = pendingNotifications.get(previousKey);
		if (previousTid !== undefined) {
			clearTimeout(previousTid);
			pendingNotifications.delete(previousKey);
		}
		joinWaiters.delete(previousKey);
	}

	function describeCompletedAgent(id: number): string | undefined {
		const state = agents.get(id);
		if (!state || state.status === "running") return undefined;
		return `Agent #${id} [${state.name}] has finished with status ${state.status.toUpperCase()}.`;
	}

	function settleCompletionWaiters(): void {
		for (const waiter of Array.from(completionWaiters)) {
			if (waiter.mode === "any") {
				const finishedId = Array.from(waiter.ids).find((id) => agents.get(id)?.status !== "running");
				if (finishedId !== undefined) {
					completionWaiters.delete(waiter);
					waiter.resolve(describeCompletedAgent(finishedId) ?? `Agent #${finishedId} has finished.`);
				}
			} else {
				const allDone = Array.from(waiter.ids).every((id) => agents.get(id)?.status !== "running");
				if (allDone) {
					const lines = Array.from(waiter.ids)
						.map((id) => `#${id} ${agents.get(id)?.status.toUpperCase() ?? "UNKNOWN"}`)
						.join("\n");
					completionWaiters.delete(waiter);
					waiter.resolve(`All specified agents have finished:\n${lines}`);
				}
			}
		}
	}

	/** Computes next agent ID: 1 when empty, else max(existing) + 1. Ensures IDs reset after /aclear or /akill. */
	function nextAgentId(): number {
		if (agents.size === 0) return 1;
		return Math.max(...agents.keys()) + 1;
	}

	function persistAgentArtifact(cwd: string, agentId: number, text: string): string {
		const dir = path.resolve(cwd, ".pi", "agent-sessions", "artifacts");
		mkdirSync(dir, { recursive: true });
		const file = path.resolve(dir, `agent-${agentId}-${Date.now()}.txt`);
		writeFileSync(file, text, "utf-8");
		return file;
	}

	function findAgentDef(cwd: string, selector?: string, agentFile?: string): AgentDef | null {
		if (agentFile?.trim()) {
			const fullPath = path.isAbsolute(agentFile) ? agentFile : path.resolve(cwd, agentFile);
			return parseAgentFile(fullPath);
		}
		if (!selector?.trim()) return null;
		const wanted = selector.trim().toLowerCase();
		return scanAgentDirs(cwd).find((def) => {
			const byName = def.name.toLowerCase() === wanted;
			const byFile = path.basename(def.file, path.extname(def.file)).toLowerCase() === wanted;
			return byName || byFile;
		}) ?? null;
	}

	function combineSystemPrompts(...parts: Array<string | undefined>): string | undefined {
		const combined = parts.map((part) => part?.trim()).filter(Boolean).join("\n\n");
		return combined || undefined;
	}

	// Single shared timer — all agents updated simultaneously.
	// CRITICAL: per-agent timers each called setWidget at different times, causing
	// Pi to reorder widgets (visual "jumping"). One timer = all updated atomically.
	let sharedTimer: ReturnType<typeof setInterval> | undefined;

	// ── Timer ─────────────────────────────────────────────────────────

	function ensureTimer() {
		if (sharedTimer) return;
		sharedTimer = setInterval(() => {
			let anyRunning = false;
			for (const state of agents.values()) {
				if (state.status === "running") {
					state.elapsed = Date.now() - state.startTime;
					anyRunning = true;
				}
			}
			updateAllWidgets();
			if (!anyRunning) {
				clearInterval(sharedTimer);
				sharedTimer = undefined;
			}
		}, WIDGET_UPDATE_INTERVAL_MS);
	}

	function stopTimer() {
		if (sharedTimer) {
			clearInterval(sharedTimer);
			sharedTimer = undefined;
		}
	}

	// ── Widget Rendering ───────────────────────────────────────────────
	//
	// Expand-on-Focus: all agents render as compact single-line widgets,
	// while one focused agent (usually the most recently active running one)
	// expands to show task + current action.

	function updateAllWidgets() {
		if (!activeCtx) return;
		const focusedId = getFocusedAgentId(Array.from(agents.values()));
		for (const [id, state] of agents) {
			activeCtx.ui.setWidget(`agent-${id}`, (_tui, theme) => {
				const isFocused = state.id === focusedId;

				return {
					render(width: number): string[] {
						const lines = renderAgentBlock(state, isFocused, width, theme, false);
						return ["", ...lines];
					},
					invalidate() {},
				};
			}, { placement: "belowEditor" });
		}
	}

	// ── Process Management ─────────────────────────────────────────────

	/** Kills all running subagent processes. Used on exit and session shutdown. */
	function killAllAgents(): void {
		for (const state of agents.values()) {
			if (state.proc && state.status === "running") {
				killProcess(state.proc);
			}
		}
	}

	function killAgent(state: SubAgentState): boolean {
		if (!state.proc || state.status !== "running") return false;
		state.killed = true;
		killProcess(state.proc);
		return true;
	}

	async function runAgent(state: SubAgentState, toolList: string[], model?: string, onComplete?: () => void) {
		toolList = canonicalizeToolList(toolList);
		state.tools = toolList.join(",");
		const currentRunSeq = state.runSeq;
		const key = runKey(state.id, currentRunSeq);

		// Verify session file exists before spawning (retry for Windows FS delay)
		let found = false;
		for (let attempt = 0; attempt <= SESSION_FILE_RETRY_ATTEMPTS; attempt++) {
			if (existsSync(path.resolve(state.sessionFile))) {
				found = true;
				break;
			}
			if (attempt < SESSION_FILE_RETRY_ATTEMPTS) {
				await new Promise((r) => setTimeout(r, SESSION_FILE_RETRY_DELAY_MS));
			}
		}
		if (!found) {
			state.status = "error";
			state.stderrLines.push(`Session file not found: ${state.sessionFile}`);
			updateAllWidgets();
			return;
		}

		const cwd = activeCtx?.cwd || process.cwd();
		const extensions = resolveExtensions(toolList, import.meta.url);

		const proc = spawnPiProcess({
			task: state.task,
			sessionFile: state.sessionFile,
			toolList,
			extensions,
			model,
			cwd,
			isContinuation: state.turnCount > 1,
			appendSystemPrompt: state.systemPrompt,
			extraEnv: { PI_AGENT_ALLOWED_TOOLS: toolList.join(",") }
		});

		state.proc = proc;
		let buf = "";
		ensureTimer();

		// Safety timeout: kill if still running after 15 minutes.
		// Prevents the main agent from being permanently blocked in agent_join.
		const timeoutId = setTimeout(() => {
			if (state.status === "running") {
				state.timedOut = true;
				state.killed = true;
				if (state.proc) {
					killProcess(state.proc);
					scheduleForceKill(state.proc);
				}
			}
		}, AGENT_JOIN_TIMEOUT_MS);

		// ── stdout: parse JSON events ─────────────────────────────────

		proc.stdout!.setEncoding("utf-8");
		proc.stdout!.on("data", (chunk: string) => {
			if (state.runSeq !== currentRunSeq) return;
			buf += chunk;
			const lines = buf.split("\n");
			buf = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				state.lastActivityAt = Date.now();
				try {
					parseAgentEvent(JSON.parse(line), state);
				} catch { /* skip malformed JSON lines */ }
			}
		});

		// ── stderr: capture for debugging ────────────────────────────

		proc.stderr!.setEncoding("utf-8");
		proc.stderr!.on("data", (chunk: string) => {
			if (state.runSeq !== currentRunSeq) return;
			// Store last few lines of stderr (useful for diagnosing errors)
			const lines = chunk.split("\n").filter(l => l.trim());
			for (const line of lines) {
				state.lastActivityAt = Date.now();
				state.stderrLines.push(line);
				if (state.stderrLines.length > MAX_STDERR_LINES) state.stderrLines.shift();
			}
		});

		// ── close: finalize state ─────────────────────────────────────

		proc.on("close", (code) => {
			clearTimeout(timeoutId);
			if (state.runSeq !== currentRunSeq) return;
			if (!agents.has(state.id)) return; // Agent removed by /akill

			// Flush remaining buffer (may contain multiple complete lines)
			for (const line of buf.split("\n").filter((l) => l.trim())) {
				state.lastActivityAt = Date.now();
				try {
					parseAgentEvent(JSON.parse(line), state);
				} catch {}
			}

			state.status = (!state.killed && code === 0) ? "done" : "error";
			state.lastActivityAt = Date.now();
			state.proc = undefined;
			updateAllWidgets();
			settleCompletionWaiters();
			onComplete?.();

			// Only send follow-up if NOT killed/timed-out by us
			if (!state.killed && activeCtx) {
				const notifType = state.status === "done" ? "success" : "error";
				activeCtx.ui.notify(
					`Agent #${state.id} [${state.name}] ${state.status}!`,
					notifType
				);

				// Notifications logic:
				// - "off": no chat message
				// - "ui" (default): UI only (handled above)
				// - "turn": trigger turn in chat (legacy/advanced mode)
				const mode = state.notifyMode ?? "ui";
				if (mode === "turn" && !joinWaiters.has(key) && !joinedRuns.has(key)) {
					const tid = setTimeout(() => {
						pendingNotifications.delete(key);
						if (!joinedRuns.has(key) && agents.get(state.id)?.runSeq === currentRunSeq && activeCtx) {
							pi.sendMessage({
								customType: "agent-notification",
								content: `📢 Agent #${state.id} [${state.name}] has finished its task.\n\nUse agent_join with id: ${state.id} to retrieve the result.`,
								display: true,
							}, { deliverAs: "followUp", triggerTurn: true });
						}
					}, AGENT_NOTIFICATION_DELAY_MS);
					pendingNotifications.set(key, tid);
				}
			}
		});

		// ── error: spawn failed ───────────────────────────────────────

		proc.on("error", (err: Error) => {
			clearTimeout(timeoutId);
			if (!agents.has(state.id)) return; // Agent removed by /akill
			state.status = "error";
			state.stderrLines.push(`Spawn error: ${err.message}`);
			if (state.proc) {
				try { state.proc.kill("SIGTERM"); } catch {}
			}
			state.proc = undefined;
			updateAllWidgets();
			settleCompletionWaiters();
			onComplete?.();
		});
	}

	/**
	 * Run agent and wait for completion. Resolves when the sub-agent process exits.
	 * Used by the sub-agent chat overlay for synchronous continuation.
	 */
	function runAgentAndWait(state: SubAgentState, prompt: string, ctx: ExtensionContext): Promise<void> {
		return new Promise((resolve) => {
			beginAgentRun(state, prompt);
			agents.set(state.id, state);
			updateAllWidgets();

			const toolList = state.tools
				? state.tools.split(",").map((t) => t.trim()).filter(Boolean)
				: resolveTagsToTools("Bash");
			const model = currentModelString(ctx.model);
			runAgent(state, toolList, model, () => resolve());
		});
	}

	// ── Tools ──────────────────────────────────────────────────────────

	if (isAllowed("agent_wait_any")) pi.registerTool({
		name: "agent_wait_any",
		label: "Wait for Any Agent",
		description: "Wait until ANY of the specified agents finish. Returns immediately if one is already done. Optional: ids (number[]).",
		parameters: AgentWaitParams,
		async execute(_id, params, signal) {
			const targetIds = params.ids && params.ids.length > 0
				? params.ids
				: Array.from(agents.values()).filter(a => a.status === "running").map(a => a.id);

			if (targetIds.length === 0) {
				return { content: [{ type: "text", text: "No running agents to wait for." }] };
			}

			const immediate = targetIds.map((id) => describeCompletedAgent(id)).find(Boolean);
			if (immediate) return { content: [{ type: "text", text: immediate }] };

			const timeoutMs = params.timeoutMs || AGENT_JOIN_TIMEOUT_MS;
			const output = await new Promise<string>((resolve) => {
				const waiter = { ids: new Set(targetIds), mode: "any" as const, resolve };
				completionWaiters.add(waiter);
				const timeout = setTimeout(() => {
					completionWaiters.delete(waiter);
					resolve("Wait timed out.");
				}, timeoutMs);
				signal?.addEventListener("abort", () => {
					clearTimeout(timeout);
					completionWaiters.delete(waiter);
					resolve("Wait cancelled by user.");
				}, { once: true });
				const originalResolve = resolve;
				waiter.resolve = (text: string) => {
					clearTimeout(timeout);
					originalResolve(text);
				};
			});
			return { content: [{ type: "text", text: output }] };
		},
	});

	if (isAllowed("agent_wait_all")) pi.registerTool({
		name: "agent_wait_all",
		label: "Wait for All Agents",
		description: "Wait until ALL specified agents finish. Optional: ids (number[]).",
		parameters: AgentWaitParams,
		async execute(_id, params, signal) {
			const targetIds = params.ids && params.ids.length > 0
				? params.ids
				: Array.from(agents.values()).filter(a => a.status === "running").map(a => a.id);

			if (targetIds.length === 0) {
				return { content: [{ type: "text", text: "No running agents to wait for." }] };
			}

			const alreadyDone = targetIds.every((id) => agents.get(id)?.status !== "running");
			if (alreadyDone) {
				const lines = targetIds.map((id) => `#${id} ${agents.get(id)?.status.toUpperCase() ?? "UNKNOWN"}`).join("\n");
				return { content: [{ type: "text", text: `All specified agents have finished:\n${lines}` }] };
			}

			const timeoutMs = params.timeoutMs || AGENT_JOIN_TIMEOUT_MS;
			const output = await new Promise<string>((resolve) => {
				const waiter = { ids: new Set(targetIds), mode: "all" as const, resolve };
				completionWaiters.add(waiter);
				const timeout = setTimeout(() => {
					completionWaiters.delete(waiter);
					resolve("Wait timed out.");
				}, timeoutMs);
				signal?.addEventListener("abort", () => {
					clearTimeout(timeout);
					completionWaiters.delete(waiter);
					resolve("Wait cancelled by user.");
				}, { once: true });
				const originalResolve = resolve;
				waiter.resolve = (text: string) => {
					clearTimeout(timeout);
					originalResolve(text);
				};
			});
			return { content: [{ type: "text", text: output }] };
		},
	});

	if (isAllowed("agent_spawn")) pi.registerTool({
		name: "agent_spawn",
		label: "Spawn Agent",
		description: "Spawn a background sub-agent. Returns ID immediately. Required: task. Optional: agent/agentFile (load role prompt + tools from .md), name override, systemPrompt append, tier, tags override, model, notify, format. (Sub-agents ALWAYS include read, glob, grep, find, ls).",
		parameters: AgentSpawnParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			activeCtx = ctx;
			const cwd = ctx.cwd || process.cwd();
			const id = nextAgentId();
			const agentDef = findAgentDef(cwd, params.agent, params.agentFile);
			const explicitTags = params.tags?.trim();
			const toolList = explicitTags
				? resolveToolsParam(explicitTags)
				: agentDef?.tools
					? canonicalizeToolList(agentDef.tools.split(",").map((t) => t.trim()).filter(Boolean))
					: resolveToolsParam(undefined);
			const parentModel = currentModelString(ctx.model);
			const model = resolveModel({ model: params.model, tier: params.tier, tiers: modelTiers, fallback: parentModel });
			const resolvedTier = params.tier ?? reverseLookupTier(model ?? "", modelTiers);
			const rolePrompt = agentDef?.systemPrompt;
			const mergedSystemPrompt = combineSystemPrompts(rolePrompt, params.systemPrompt);
			const state: SubAgentState = {
				id,
				name: params.name || agentDef?.name || `agent-${id}`,
				status: "running",
				resultJoined: false,
				task: params.task,
				lastAssistantText: "",
				lastErrorMessage: "",
				currentStreamText: "",
				toolCount: 0,
				turnCount: 1,
				elapsed: 0,
				startTime: Date.now(),
				sessionFile: makeSessionFile(id, cwd),
				killed: false,
				timedOut: false,
				stderrLines: [],
				tools: toolList.join(","),
				tags: explicitTags || (agentDef ? "agent-def" : undefined),
				model,
				tier: resolvedTier,
				runSeq: 1,
				notifyMode: params.notify || "ui",
				systemPrompt: mergedSystemPrompt,
				agentFile: agentDef?.file,
				lastActivityAt: Date.now(),
			};
			agents.set(id, state);

			runAgent(state, toolList, model);
			updateAllWidgets();

			const tagLabel = explicitTags || (agentDef ? "agent-def" : undefined);
			const metaParts = formatAgentMetaBracketed({ tier: resolvedTier, model, tags: tagLabel });
			const roleInfo = agentDef ? ` role=${agentDef.name}` : "";
			const output = `Agent #${id} [${state.name}]${metaParts ? ` ${metaParts}` : ""} spawned.${roleInfo} Use agent_join(${id}) for result.`;
			return { content: [{ type: "text", text: output }], details: { format: params.format, role: agentDef?.name, agentFile: agentDef?.file, systemPromptInjected: Boolean(mergedSystemPrompt) } };
		},
	});

	if (isAllowed("agent_join")) pi.registerTool({
		name: "agent_join",
		label: "Join Agent",
		description: "Wait for sub-agent to finish and return its output. Optionally save the full output to an artifact file. Times out after 15 min. Required: id (number). Repeat calls are allowed.",
		parameters: AgentJoinParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const state = agents.get(params.id);
			if (!state) {
				return {
					content: [{ type: "text", text: `Error: No agent with id ${params.id}. Use agent_list to see active agents.` }],
					isError: true,
				};
			}

			const currentRunSeq = state.runSeq;
			const key = runKey(state.id, currentRunSeq);

			if (state.timedOut) {
				return {
					content: [{ type: "text", text: `Agent #${params.id} timed out (exceeded 15 minute limit).` }],
					isError: true,
				};
			}
			if (state.killed) {
				return {
					content: [{ type: "text", text: `Agent #${params.id} was killed before completing.` }],
					isError: true,
				};
			}

			joinWaiters.add(key);
			try {
				const deadline = Date.now() + AGENT_JOIN_TIMEOUT_MS;

				while (state.status === "running" && !signal?.aborted && Date.now() < deadline) {
					await new Promise<void>((resolve) => {
						const t = setTimeout(resolve, AGENT_JOIN_POLL_INTERVAL_MS);
						signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
					});
				}

				if (signal?.aborted) {
					return {
						content: [{ type: "text", text: `agent_join cancelled by user (Escape pressed). Agent #${params.id} is still running.` }],
						isError: true,
					};
				}
				if (state.status === "running") {
					if (state.proc) {
						killProcess(state.proc);
						scheduleForceKill(state.proc);
					}
					return {
						content: [{ type: "text", text: `agent_join timed out waiting for agent #${params.id} (15 min limit). Agent has been terminated.` }],
						isError: true,
					};
				}
				if (state.status === "error") {
					const errDetails = state.stderrLines.length > 0
						? `\n\nStderr:\n${state.stderrLines.join("\n")}`
						: "";
					const lastErr = state.lastErrorMessage ? `\n\nLast API/Model error: ${state.lastErrorMessage}` : "";
					return {
						content: [{
							type: "text",
							text: `Agent #${params.id} finished with an error.${lastErr}${errDetails}${state.lastAssistantText ? `\n\nPartial output:\n${state.lastAssistantText}` : ""}`,
						}],
						isError: true,
					};
				}

				// ── Success branch: Extract result ──

				// 1. Try in-memory state (fastest)
				let resultText = state.lastAssistantText;

				// 2. Fallback to structured session extraction
				if (!resultText && state.sessionFile) {
					const terminal = extractTerminalResultFromFile(state.sessionFile);
					if (terminal.kind === "text") {
						resultText = terminal.text || "";
					} else if (terminal.kind === "error") {
						resultText = `Agent finished without final answer.\nError: ${terminal.error}`;
					} else if (terminal.kind === "tool-only") {
						resultText = `Agent finished task via tools but produced no final text summary. Check the session (/aenter ${state.id}) for details.`;
					}
				}

				// If still empty
				if (!resultText) {
					resultText = state.sessionFile
						? "(agent produced no text output; use /aenter " + state.id + " to view conversation)"
						: "(agent produced no text output)";
				}

				const isAutoArtifact = resultText.length > MAX_FULL_OUTPUT;
				const shouldPersist = params.artifact || isAutoArtifact;
				const previewFormat = shouldPersist && !params.format ? "summary only" : params.format;
				const formatted = formatAgentOutputDetailed(resultText, previewFormat);
				const artifactPath = shouldPersist ? persistAgentArtifact(ctx.cwd || process.cwd(), state.id, resultText) : undefined;

				state.resultJoined = true;
				joinedRuns.add(key);
				return {
					content: [{
						type: "text",
						text: artifactPath
							? `${formatted.text}\n\n${formatted.truncated ? "Output truncated." : ""} Full output saved to:\n${artifactPath}`
							: formatted.text,
					}],
					details: {
						format: previewFormat,
						summary: state.lastAssistantText
							? state.lastAssistantText.split("\n\n")[0]?.slice(0, 200)
							: resultText.split("\n\n")[0]?.slice(0, 200),
						status: state.status,
						turnCount: state.turnCount,
						toolCount: state.toolCount,
						truncated: formatted.truncated,
						originalLength: formatted.originalLength,
						sessionFile: state.sessionFile,
						artifact: Boolean(artifactPath),
						artifactPath,
						fullOutputPath: artifactPath,
						autoArtifact: isAutoArtifact,
					},
				};
			} finally {
				joinWaiters.delete(key);
				const tid = pendingNotifications.get(key);
				if (tid !== undefined) {
					clearTimeout(tid);
					pendingNotifications.delete(key);
				}
			}
		},
	});

	if (isAllowed("agent_continue")) pi.registerTool({
		name: "agent_continue",
		label: "Continue Agent",
		description: "Continue sub-agent with new instructions. Reuses session history. Returns immediately. Required: id (number), prompt. Optional: tags, tier, model, notify, format. (Sub-agents ALWAYS have read, glob, grep, find, ls).",
		parameters: AgentContinueParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			activeCtx = ctx;
			const state = agents.get(params.id);
			if (!state) {
				return {
					content: [{ type: "text", text: `Error: No agent with id ${params.id}. Use agent_list to see active agents.` }],
					isError: true,
				};
			}
			if (state.status === "running") {
				return {
					content: [{ type: "text", text: `Error: Agent #${params.id} is still running. Wait for it to finish or use /akill ${params.id} to terminate it.` }],
					isError: true,
				};
			}
			if (state.timedOut) {
				return {
					content: [{ type: "text", text: `Agent #${params.id} timed out and cannot be continued.` }],
					isError: true,
				};
			}
			if (!existsSync(state.sessionFile)) {
				return {
					content: [{ type: "text", text: `Error: Session file for agent #${params.id} not found. Cannot continue.` }],
					isError: true,
				};
			}

			beginAgentRun(state, params.prompt, params.notify);

			const toolList = params.tags
				? resolveToolsParam(params.tags)
				: state.tools.split(",").map((t) => t.trim()).filter(Boolean);
			state.tools = toolList.join(",");
			state.tags = params.tags ?? state.tags;
			if (params.systemPrompt?.trim()) {
				state.systemPrompt = combineSystemPrompts(state.systemPrompt, params.systemPrompt);
			}

			// Resolve model: explicit param > tier param > previously set model > parent model
			const parentModel = currentModelString(ctx.model);
			const model = resolveModel({ model: params.model, tier: params.tier, tiers: modelTiers, fallback: state.model ?? parentModel });
			state.model = model;
			state.tier = params.tier ?? reverseLookupTier(model ?? "", modelTiers) ?? state.tier;

			agents.set(params.id, state);
			updateAllWidgets();

			runAgent(state, toolList, model);

			const metaParts = formatAgentMetaBracketed({ tier: state.tier, model, tags: state.tags });
			const output = `Agent #${params.id} [${state.name}]${metaParts ? ` ${metaParts}` : ""} continuing (Turn ${state.turnCount}). Use agent_join(${params.id}) for result.`;
			return { content: [{ type: "text", text: output }], details: { format: params.format } };
		},
	});

	if (isAllowed("agent_list")) pi.registerTool({
		name: "agent_list",
		label: "List Agents",
		description: "List all background agents.",
		parameters: AgentListParams,
		async execute() {
			if (agents.size === 0) {
				return { content: [{ type: "text", text: "No agents have been spawned." }] };
			}
			const lines = Array.from(agents.values()).map(s => {
				const elapsed = `${Math.round(s.elapsed / 1000)}s`;
				const suffix = s.killed ? " [killed]" : s.timedOut ? " [timed out]" : "";
				const joinSuffix = s.status === "done" ? (s.resultJoined ? " [joined]" : " [awaiting join]") : "";
				const meta = formatAgentMetaInline(s);
				return `#${s.id} [${s.name}] ${s.status.toUpperCase()}${suffix}${joinSuffix} — ${elapsed} · ${s.turnCount} turns · ${s.toolCount} tools${meta ? ` · ${meta}` : ""}`;
			});
			return { content: [{ type: "text", text: `Agents:\n${lines.join("\n")}` }] };
		},
	});

	// ── Sub-agent Chat Overlay ────────────────────────────────────────

	async function openSubAgentChatOverlay(
		state: SubAgentState,
		ctx: ExtensionContext,
		onBack: () => void,
	): Promise<void> {
		let items = parseSessionFile(state.sessionFile);
		let mode: "input" | "sending" = "input";

		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const editor = new Editor(tui, { borderColor: (s: string) => theme.fg("accent", s) });
			editor.onSubmit = (text: string) => {
				if (!text?.trim() || mode === "sending") return;
				mode = "sending";
				runAgentAndWait(state, text.trim(), ctx).then(() => {
					items = existsSync(state.sessionFile)
						? parseSessionFile(state.sessionFile)
						: items;
					mode = "input";
					tui.requestRender();
				});
			};

			return {
				handleInput(data: string) {
					if (matchesKey(data, Key.escape)) {
						onBack();
						done();
						return;
					}
					if (mode === "sending") {
						tui.requestRender();
						return;
					}
					editor.handleInput(data);
					tui.requestRender();
				},
				render(width: number): string[] {
					const lines: string[] = [];
					lines.push("");
					lines.push(truncateToWidth(
						theme.fg("accent", "───") +
						theme.fg("accent", ` Chat with Agent #${state.id} [${state.name}] `) +
						theme.fg("accent", "─".repeat(Math.max(0, width - 35))),
						width
					));
					lines.push("");

					if (mode === "sending") {
						lines.push(truncateToWidth("  " + theme.fg("accent", "Agent is thinking..."), width));
						lines.push("");
					} else {
						const visibleItems = items.slice(-12);
						for (const item of visibleItems) {
							let icon = ">";
							let color = "dim";
							if (item.type === "user") { icon = ">"; color = "success"; }
							else if (item.type === "assistant") { icon = "<"; color = "accent"; }
							else if (item.type === "tool") { icon = "#"; color = "warning"; }
							const preview = item.content.replace(/\n/g, " ").slice(0, width - 8);
							lines.push(truncateToWidth(
								"  " + theme.fg(color, `${icon} `) + theme.fg("dim", preview),
								width
							));
						}
						lines.push("");
						lines.push(truncateToWidth("  " + theme.fg("dim", "Your message:"), width));
						editor.render(Math.max(20, width - 4)).forEach((l) => lines.push("  " + l));
					}

					lines.push("");
					lines.push(truncateToWidth(
						"  " + theme.fg("dim", mode === "sending" ? "Waiting for agent..." : "Enter = send | Esc = back"),
						width
					));
					lines.push("");
					return lines;
				},
				invalidate() {},
			};
		}, { overlay: true, overlayOptions: { width: "85%", anchor: "center" } });
	}

	// ── Commands ───────────────────────────────────────────────────────

	pi.registerCommand("agents", {
		description: "Show all sub-agents in an overlay (Enter = chat with agent)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;

			async function runAgentsLoop(): Promise<void> {
				const agentList = Array.from(agents.values());
				let selectedIndex = 0;

				type ListResult = { action: "chat"; agent: SubAgentState } | { action: "close" } | undefined;
				const result = await ctx.ui.custom<ListResult>((tui, theme, _kb, done) => ({
					handleInput(data: string) {
						if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
							done({ action: "close" });
							return;
						}
						if (matchesKey(data, Key.up)) {
							selectedIndex = Math.max(0, selectedIndex - 1);
							tui.requestRender();
							return;
						}
						if (matchesKey(data, Key.down)) {
							selectedIndex = Math.min(agentList.length - 1, selectedIndex + 1);
							tui.requestRender();
							return;
						}
						if (matchesKey(data, Key.enter) && agentList.length > 0) {
							const agent = agentList[selectedIndex];
							if (agent.status === "running") {
								ctx.ui.notify("Agent is still running. Use /akill to stop or wait for completion.", "warning");
								tui.requestRender();
								return;
							}
							if (agent.timedOut || !existsSync(agent.sessionFile)) {
								ctx.ui.notify(`Cannot chat with agent #${agent.id} (timed out or session missing).`, "error");
								tui.requestRender();
								return;
							}
							done({ action: "chat", agent });
							return;
						}
					},
					render(width: number): string[] {
						return renderAgentsListLines(agentList, selectedIndex, width, theme);
					},
					invalidate() {},
				}), { overlay: true });

				if (result?.action === "chat") {
					await openSubAgentChatOverlay(result.agent, ctx, () => { /* done closes overlay */ });
					await runAgentsLoop();
				}
			}

			await runAgentsLoop();
		},
	});

	pi.registerCommand("aenter", {
		description: "Enter chat with sub-agent: /aenter <id>",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const id = parseInt(args?.trim() || "", 10);
			if (isNaN(id)) {
				ctx.ui.notify("Usage: /aenter <id>", "error");
				return;
			}
			const state = agents.get(id);
			if (!state) {
				ctx.ui.notify(`No agent #${id} found. Use /agents to see available agents.`, "error");
				return;
			}
			if (state.status === "running") {
				ctx.ui.notify("Agent is still running. Wait for it to finish or use /akill.", "warning");
				return;
			}
			if (state.timedOut) {
				ctx.ui.notify(`Agent #${id} timed out and cannot be continued.`, "error");
				return;
			}
			if (!existsSync(state.sessionFile)) {
				ctx.ui.notify(`Agent #${id} session file not found.`, "error");
				return;
			}
			await openSubAgentChatOverlay(state, ctx, () => {});
		},
	});

	pi.registerCommand("akill", {
		description: "Kill a running sub-agent: /akill <id>",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const id = parseInt(args?.trim() || "", 10);
			if (isNaN(id)) {
				ctx.ui.notify("Usage: /akill <id>", "error");
				return;
			}
			const state = agents.get(id);
			if (!state) {
				ctx.ui.notify(`No agent #${id} found.`, "error");
				return;
			}
			if (state.status !== "running") {
				ctx.ui.notify(`Agent #${id} is already ${state.status}.`, "warning");
				return;
			}
			killAgent(state);
			clearAgentState(id);
			agents.delete(id);
			ctx.ui.setWidget(`agent-${id}`, undefined);
			ctx.ui.notify(`Agent #${id} [${state.name}] killed and removed.`, "warning");
			updateAllWidgets();
		},
	});

	pi.registerCommand("acont", {
		description: "Continue a finished sub-agent: /acont <id> <prompt>",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const trimmed = args?.trim() ?? "";
			const spaceIdx = trimmed.indexOf(" ");
			if (spaceIdx === -1) {
				ctx.ui.notify("Usage: /acont <id> <prompt>", "error");
				return;
			}

			const id = parseInt(trimmed.slice(0, spaceIdx), 10);
			const prompt = trimmed.slice(spaceIdx + 1).trim();

			if (isNaN(id) || !prompt) {
				ctx.ui.notify("Usage: /acont <id> <prompt>", "error");
				return;
			}

			const state = agents.get(id);
			if (!state) {
				ctx.ui.notify(`No agent #${id} found. Use /agents to see available agents.`, "error");
				return;
			}
			if (state.status === "running") {
				ctx.ui.notify(`Agent #${id} is still running. Wait for it to finish or use /akill ${id}.`, "warning");
				return;
			}
			if (state.timedOut) {
				ctx.ui.notify(`Agent #${id} timed out and cannot be continued.`, "error");
				return;
			}
			// Verify session file exists
			if (!existsSync(state.sessionFile)) {
				ctx.ui.notify(`Agent #${id} session file not found. Cannot continue.`, "error");
				return;
			}

			// Reset state for continuation
			state.status = "running";
			state.task = prompt;
			state.lastAssistantText = "";
			state.toolCount = 0;
			state.turnCount++;
			state.elapsed = 0;
			state.startTime = Date.now();
			state.killed = false;
			state.timedOut = false;
			state.stderrLines = [];
			state.lastTool = undefined;

			const toolList = state.tools
				? state.tools.split(",").map((t) => t.trim()).filter(Boolean)
				: resolveTagsToTools("Bash");
			state.tools = toolList.join(",");

			updateAllWidgets();

			const model = currentModelString(ctx.model);
			runAgent(state, toolList, model);

			ctx.ui.notify(`Agent #${id} [${state.name}] continuing (Turn ${state.turnCount})…`, "info");
		},
	});

	pi.registerCommand("aclear", {
		description: "Remove all finished/errored agents from UI",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			let count = 0;
			for (const [id, state] of agents) {
				if (state.status !== "running") {
					clearAgentState(id);
					ctx.ui.setWidget(`agent-${id}`, undefined);
					agents.delete(id);
					count++;
				}
			}
			ctx.ui.notify(
				count > 0
					? `Cleared ${count} agent${count !== 1 ? "s" : ""}.`
					: "No finished agents to clear.",
				count > 0 ? "success" : "info"
			);
		},
	});

	// ── Lifecycle ──────────────────────────────────────────────────────

	// Process-level cleanup: kill subagents when parent exits (e.g. console closed).
	// session_shutdown may not fire on abrupt kill; these handlers ensure cleanup.
	process.on("exit", () => { killAllAgents(); });
	process.on("beforeExit", () => { killAllAgents(); });
	process.on("SIGINT", () => { killAllAgents(); });
	process.on("SIGTERM", () => { killAllAgents(); });

	pi.on("before_agent_start", async (event) => {
		// Main agent needs orchestration policy; restricted sub-agents do not.
		if (process.env.PI_AGENT_ALLOWED_TOOLS) return undefined;
		return {
			systemPrompt: event.systemPrompt + "\n\n" + ORCHESTRATOR_GUIDANCE,
		};
	});

	pi.on("session_start", async (_e, ctx) => {
		activeCtx = ctx;
		modelTiers = loadModelTiers(ctx.cwd);
		// Clean up any leftover agents from a previous session
		for (const [id, state] of agents) {
			if (state.proc) killProcess(state.proc);
			ctx.ui.setWidget(`agent-${id}`, undefined);
		}
		agents.clear();
		stopTimer();
		applyExtensionDefaults(import.meta.url, ctx);
		ctx.ui.notify("BaseAgents (Orchestration) Loaded", "info");
	});

	pi.on("session_shutdown", async () => {
		stopTimer();
		killAllAgents();
		for (const state of agents.values()) {
			// Clean up session file
			if (state.sessionFile && existsSync(state.sessionFile)) {
				try { unlinkSync(state.sessionFile); } catch {}
			}
		}
		// Clean up orphaned session files in project-local dirs
		const sessionDirs = new Set(Array.from(agents.values()).map((s) => path.dirname(s.sessionFile)));
		for (const sessionDir of sessionDirs) {
			cleanSessionDir(sessionDir);
		}
		// Also clean activeCtx project dir if set (handles case where agents were cleared)
		if (activeCtx?.cwd) {
			cleanSessionDir(path.resolve(activeCtx.cwd, ".pi", "agent-sessions", "subagents"));
		}
	});
}
