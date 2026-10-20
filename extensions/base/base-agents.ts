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
 *   /aclear       — Hide finished/errored widgets; retain agents and results
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
 * Waiting is bounded independently of execution; a wait timeout never kills an agent.
 * Explicit runtimeBudgetMs optionally limits execution; interrupted sessions can be continued.
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
import { ADVERTISED_TAGS_DESCRIPTION, resolveTagsToTools } from "./agent-tags.ts";
import { validateDelegationPrompt } from "./delegation-guard.ts";
import { invalidArgument } from "./tool-contract.ts";
import { ALLOWED_TOOLS_ENV, buildAllowedToolsEnv } from "./allowed-tools.ts";
import { getCompletionFilePath, persistCompletionEnvelope, readCompletionEnvelope, type AgentInterruptionReason } from "./agent-completion.ts";
import { buildPhaseGuidance, normalizePhase, type AgentWorkPhase, validatePhaseTransition } from "./coordinator-mode.ts";
import { buildForkContextPrompt, normalizeForkContextMode, normalizeSpawnMode, type AgentSpawnMode, type ForkContextMode } from "./fork-context.ts";
import {
	parseAgentEvent,
	parseSessionFile,
	extractTerminalResultFromFile,
	type HistoryItem,
} from "./agent-events.ts";
import {
	AGENT_JOIN_TIMEOUT_MS,
	AGENT_NOTIFICATION_DELAY_MS,
	MAX_FULL_OUTPUT,
	MAX_STDERR_LINES,
	SESSION_FILE_RETRY_ATTEMPTS,
	SESSION_FILE_RETRY_DELAY_MS,
	WIDGET_UPDATE_INTERVAL_MS,
	canonicalizeToolList,
	formatAgentOutputDetailed,
	killProcess,
	makeSessionFile,
	resolveExtensions,
	resolveToolsParam,
	scheduleForceKill,
	spawnPiProcess,
} from "./agent-runner.ts";
import {
	loadModelTiers,
	resolveModel,
	reverseLookupTier,
	resolveThinkingLevel,
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
	resultJoined: boolean;
	/** Screen visibility only; hidden agents remain available to tools and /agents. */
	widgetHidden?: boolean;
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
	runtimeBudgetMs: number;
	interruptionReason?: AgentInterruptionReason;
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
	/** Timestamp of the latest visible activity for auto-focus in compact UI. */
	lastActivityAt: number;
	/** Completion envelope file for the current/last run. */
	completionFile?: string;
	/** Optional execution phase for orchestration. */
	phase?: AgentWorkPhase;
	/** Spawn mode: fresh or forked context. */
	spawnMode?: AgentSpawnMode;
	/** Fork context strategy used for this run. */
	forkContextMode?: ForkContextMode;
}

// ── Schemas ────────────────────────────────────────────────────────────

const FormatEnum = Type.String({
	description: 'Output detail. Allowed: "summary only" | "full output"',
});

const TierEnum = Type.String({
	description: 'Model tier and thinking level. Allowed: "high" | "medium" | "low". Omit to inherit parent model with thinking off.',
});

const NotifyEnum = Type.String({
	description: 'Notification mode. Allowed: "off" | "ui" | "turn"',
});

const PhaseEnum = Type.String({
	description: 'Work phase. Allowed: "research" | "implementation" | "verification"',
});

const SpawnModeEnum = Type.String({
	description: 'Spawn mode. Allowed: "fresh" | "fork"',
});

const ForkContextEnum = Type.String({
	description: 'Fork context mode. Allowed: "none" | "recent"',
});

const AgentSpawnParams = Type.Object({
	task: Type.String({ description: "Task description" }),
	name: Type.Optional(Type.String({ description: "Name (e.g. researcher)" })),
	tags: Type.Optional(Type.String({ description: `Capability tags as comma-separated string: ${ADVERTISED_TAGS_DESCRIPTION}. (read, glob, grep, ls, find are ALWAYS included)` })),
	format: Type.Optional(FormatEnum),
	tier: Type.Optional(TierEnum),
	model: Type.Optional(Type.String({ description: "Explicit model string (overrides tier)" })),
	notify: Type.Optional(NotifyEnum),
	phase: Type.Optional(PhaseEnum),
	mode: Type.Optional(SpawnModeEnum),
	runtimeBudgetMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 2147483647, description: "Maximum runtime in ms. 0 disables the deadline; omitted defaults to 0." })),
	context: Type.Optional(ForkContextEnum),
	contextTurns: Type.Optional(Type.Number({ description: "Recent parent turns to include in fork mode. Default: 6." })),
	contextMaxChars: Type.Optional(Type.Number({ description: "Max forked context characters. Default: 12000." })),
});

const AgentJoinParams = Type.Object({
	id: Type.Number({ description: "Agent ID" }),
	format: Type.Optional(FormatEnum),
	artifact: Type.Optional(Type.Boolean({ description: "If true, save the full agent output to an artifact file and return a preview + absolute path." })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 2147483647, description: "Wait timeout in ms. Default: 20 min. Stops waiting; does not stop the agent." })),
});

const AgentResultParams = Type.Object({
	id: Type.Number({ description: "Agent ID" }),
	runSeq: Type.Optional(Type.Number({ description: "Specific run sequence to read (defaults to latest run)." })),
	format: Type.Optional(FormatEnum),
	artifact: Type.Optional(Type.Boolean({ description: "If true, save the full agent output to an artifact file and return a preview + absolute path." })),
});

const AgentContinueParams = Type.Object({
	id: Type.Number({ description: "Agent ID" }),
	prompt: Type.String({ description: "New instructions" }),
	tags: Type.Optional(Type.String({ description: `Capability tags as comma-separated string: ${ADVERTISED_TAGS_DESCRIPTION}. (read, glob, grep, ls, find are ALWAYS included)` })),
	format: Type.Optional(FormatEnum),
	tier: Type.Optional(TierEnum),
	model: Type.Optional(Type.String({ description: "Explicit model string (overrides tier)" })),
	notify: Type.Optional(NotifyEnum),
	phase: Type.Optional(PhaseEnum),
	runtimeBudgetMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 2147483647, description: "Maximum runtime in ms. 0 clears the deadline; omitted inherits the prior budget." })),
});

const AgentWaitParams = Type.Object({
	ids: Type.Optional(Type.Array(Type.Number(), { description: "Optional list of agent IDs to wait for. If omitted, waits for ALL running agents." })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 2147483647, description: "Wait timeout in ms. Default: 20 min. Stops waiting; does not stop agents." })),
	join: Type.Optional(Type.Boolean({ description: "If true, return joined result(s) directly for completed agents." })),
	format: Type.Optional(FormatEnum),
	artifact: Type.Optional(Type.Boolean({ description: "If true, save joined full output(s) to artifact file(s)." })),
});

const AgentListParams = Type.Object({});

// ── Guidance injected into system prompt ──────────────────────────────
//
// Uses RISEN-style structure (Expectation + Narrowing) for orchestrator behavior.
// Without explicit completion criteria, agents over-deliver and scope-creep.
// See: RISEN framework, Ralph exit gates, declare_task_succeeded patterns.

const ORCHESTRATOR_GUIDANCE = `
## Agents
spawn: async, parallel task → ID (immediate)
join: wait for agent → output (default wait timeout 20min; timeout never kills agent, Escape cancels)
result: read completion result of a finished agent without waiting
continue: resume session (history preserved, turn+1)
list: all agents + status
spawn/continue runtimeBudgetMs: 0 disables deadline; omitted continuation inherits prior budget
wait timeoutMs only stops waiting; runtime-budget expiry interrupts agent; inspect partial output before resuming
CLI: /agents, /aenter <id>, /akill <id>, /acont <id> <prompt>, /aclear

## Model tiers
Choose the lowest tier that can reliably complete the delegated subtask. The parent model is the lead decision-maker: delegate evidence gathering and bounded engineering work to low/medium, then synthesize important decisions in the parent. Do not mirror the parent model's strength in every sub-agent.

low: Preferred for reconnaissance and bounded execution: locating or extracting facts, reading many files with a clear question, narrow research, summaries, formatting, lint fixes, mechanical edits, straightforward tests, simple local fixes, and other work with cheap verification. Large input, many files, or long context alone do not require a higher tier.
medium: Default for nearly all non-trivial delegation: multi-file investigation, standard feature implementation, architecture analysis, synthesis of several sources, debugging with multiple hypotheses, code review, security review, non-trivial tests, and adaptive tool loops. Trust medium to produce recommendations; the parent model reviews and makes final high-impact decisions. Code review, architecture review, final-pipeline review, verification, and read-only audits are medium territory: spawn medium agents to gather findings per area, then synthesize in the parent. Do not escalate these to high based on the word "review", "architecture", or "security" alone.
high: Exceptional only. Use for a narrowly scoped problem that genuinely needs a second frontier-level reasoning pass and cannot be handled well by the parent plus medium agents—for example, a medium attempt failed on an unusually subtle root cause, conflicting medium analyses cannot be reconciled, or an independent review is required for an exceptionally high-stakes security/data invariant. Do not use high merely because a task involves architecture, planning, ambiguity, multiple modules, or costly mistakes. A broad task (read many files, review a branch) is a signal to split or use medium, never to use high.

Prefer decomposing difficult work into low/medium subtasks over spawning high. Escalate to high only after a concrete reason is observed, not pre-emptively. When the parent model is already high-capability, it should normally perform the final reasoning itself.

## Phased orchestration
Use phase labels when the workflow is naturally split:
- research — investigate, map code, compare options, gather evidence
- implementation — make the change, write code, update tests/docs
- verification — validate behavior, review diffs, run checks, summarize risks
Prefer passing prior phase output into the next phase explicitly.

## Fork context mode
agent_spawn supports mode=fork for contextual side-workers.
- fresh — default isolated sub-agent with an empty session
- fork — injects a compact snapshot of recent parent conversation into the delegated task
Use fork only when the worker needs recent conversational context. Prefer fresh when isolation is better.

## Bounded orchestration
Prefer delegation for focused investigation, independent parallel work, or context-heavy analysis. Handle trivial, self-contained work directly; file count alone is not a reason to delegate.

- Split large work by independently verifiable outcomes, not whole layers ("implement all backend") or arbitrary tiny steps. Keep a coherent change and its focused tests together; don't hand one worker the entire feature, integration, and verification pipeline.
- Give each worker the deliverable, relevant findings/contracts, ownership boundaries or allowed files, non-goals, checks, and stop criteria. Ask for changed files, verification evidence, blockers, and remaining work. If scope grows, have the worker report a checkpoint rather than silently absorb more work.
- Run independent work in parallel, usually 2–3 workers when useful, not a quota. Establish shared contracts first; keep dependencies sequential. Avoid overlapping edits; assign shared files one owner. Serialize heavy builds/tests that share workspace resources.
- The parent owns scope, coordination, integration, and final verification. While workers run, do non-overlapping work. Collect each relevant result, inspect the actual diff, reconcile interfaces, and verify the combined behavior; worker success alone is not integration evidence.

## Agent operations
- **agent_spawn is the primary delegation tool:** Prefer it over disposable task for non-trivial work needing follow-up.
- Default notifications are UI-only. Set notify="turn" when background completion should wake the parent; still collect and verify the result. A wait timeout is not a failed task: don't restart or duplicate a running worker.
- **Use agent_join** when you need a result. It now returns diagnostic info if no text summary exists.
- **Use agent_result** to inspect a finished agent later without blocking.
- **Use join:true on agent_wait_any / agent_wait_all** when you want waiting + retrieval in one step.
- **Do not leave finished agents unjoined** if their work matters to the answer.
- For very long outputs, prefer agent_join or wait(join:true) with artifact:true to save the full result to a file and keep chat context small.
- With independent workers, prefer agent_wait_any(join:true) and start dependent work as inputs arrive. Use agent_wait_all for a real integration barrier, not by habit.
- Return bounded fixes to the same worker via agent_continue when its context remains useful. Use a fresh worker for independent review or different expertise, not to repeat completed investigation.
- After compaction or if you are unsure which agents are still active, call agent_list first to restore agent state.
- /aclear only hides finished widgets. Hidden agents keep their IDs, history and results: reuse agent_result/agent_continue instead of spawning duplicates.
- If agent_join reports no final output (e.g. tool-only or error), do not hallucinate results.

## agent_spawn vs task
- **agent_spawn:** Default choice for non-trivial delegation. Persistent session, tier routing, parallel fan-out, explicit join, and continuation support.
- **task:** Reserve for cheap, disposable, one-shot work where you only need a quick answer and do not expect follow-up or continuation.
- If you may need to build on the result later, use agent_spawn instead of task.

## Orchestrator Rules
- Deliver ONE final synthesis to the user. Do not create artifacts unless asked.
- Narrowing: Produce only what was requested. No supplemental summaries or indices.
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
	phase?: AgentWorkPhase;
	spawnMode?: AgentSpawnMode;
	forkContextMode?: ForkContextMode;
}): string[] {
	const modePart = meta.spawnMode === "fork"
		? `fork:${meta.forkContextMode || "recent"}`
		: undefined;
	return [meta.tier, modelLabel(meta.model), meta.tags, meta.phase, modePart]
		.map((part) => normalizeMetaPart(part))
		.filter((part): part is string => Boolean(part));
}

function formatAgentMetaInline(meta: {
	tier?: string;
	model?: string;
	tags?: string | string[];
	phase?: AgentWorkPhase;
	spawnMode?: AgentSpawnMode;
	forkContextMode?: ForkContextMode;
}): string {
	return getAgentMetaParts(meta).join(" · ");
}

function formatAgentMetaBracketed(meta: {
	tier?: string;
	model?: string;
	tags?: string | string[];
	phase?: AgentWorkPhase;
	spawnMode?: AgentSpawnMode;
	forkContextMode?: ForkContextMode;
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
	else if (agent.timedOut) { detailPrefix = "      "; detail = `⏱ runtime budget exceeded (${agent.runtimeBudgetMs}ms)`; detailColor = "error"; }
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
	// Re-register on every runtime/session recreation. Avoid one-time global guards here:
	// Pi 0.65+ may rebuild the extension runtime on /new, /resume, /fork, and /reload.
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
		runSeqs: Record<number, number>;
		mode: "any" | "all";
		resolve: (result: { completedIds: number[]; staleIds: number[] }) => void;
	}>();
	let activeCtx: ExtensionContext | undefined;
	let modelTiers: ModelTiers | null = null;

	function runKey(id: number, runSeq: number): string {
		return `${id}:${runSeq}`;
	}

	function validateTimeout(value: unknown, name: "timeoutMs" | "runtimeBudgetMs") {
		const minimum = name === "runtimeBudgetMs" ? 0 : 1;
		if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > 2147483647)) {
			return invalidArgument(`${name} must be an integer between ${minimum} and 2147483647.`, `Omit ${name} to use its default.`).toToolResult();
		}
	}

	function waitTimeoutResult(ids: number[], runSeqs: Record<number, number>) {
		const runningIds = ids.filter((id) => agents.get(id)?.status === "running");
		return {
			content: [{ type: "text" as const, text: `Wait timed out; no agents were stopped. Still running: ${runningIds.map((id) => `#${id}`).join(", ") || "none"}. Use agent_list or wait again; do not duplicate their work.` }],
			details: { status: "timeout", timedOut: true, runningIds, runSeqs },
		};
	}

	function staleWaitResult(ids: number[]) {
		return {
			content: [{ type: "text" as const, text: `Agent run changed while waiting: ${ids.join(", ")}. Use agent_result with the original runSeq or inspect agent_list.` }],
			details: { status: "stale_run", agentIds: ids },
			isError: true,
		};
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

	function beginAgentRun(state: SubAgentState, prompt: string, notifyMode?: "off" | "ui" | "turn", runtimeBudgetMs?: number): void {
		const recovering = state.timedOut || state.killed || state.status === "error";
		state.status = "running";
		state.resultJoined = false;
		state.widgetHidden = false;
		state.task = recovering
			? `Recovery after interrupted run: inspect current files and tool effects first. Do not blindly rerun mutations, tests, or commands. Treat partial output as unverified.\n\n${prompt}`
			: prompt;
		state.lastAssistantText = "";
		state.lastErrorMessage = "";
		state.currentStreamText = "";
		state.toolCount = 0;
		state.turnCount++;
		state.elapsed = 0;
		state.startTime = Date.now();
		state.killed = false;
		state.timedOut = false;
		state.interruptionReason = undefined;
		state.stderrLines = [];
		state.lastTool = undefined;
		state.runSeq++;
		state.completionFile = undefined;
		state.notifyMode = notifyMode ?? state.notifyMode ?? "ui";
		if (runtimeBudgetMs !== undefined) state.runtimeBudgetMs = runtimeBudgetMs;
		state.lastActivityAt = Date.now();

		const previousKey = runKey(state.id, state.runSeq - 1);
		const previousTid = pendingNotifications.get(previousKey);
		if (previousTid !== undefined) {
			clearTimeout(previousTid);
			pendingNotifications.delete(previousKey);
		}
		joinWaiters.delete(previousKey);
		settleCompletionWaiters();
	}

	function describeCompletedAgent(id: number): string | undefined {
		const state = agents.get(id);
		if (!state || state.status === "running") return undefined;
		return `Agent #${id} [${state.name}] has finished with status ${state.status.toUpperCase()}.`;
	}

	function settleCompletionWaiters(): void {
		for (const waiter of Array.from(completionWaiters)) {
			const finishedIds = Array.from(waiter.ids).filter((id) => {
				const state = agents.get(id);
				return !state || state.runSeq !== waiter.runSeqs[id] || state.status !== "running";
			});
			if ((waiter.mode === "any" && finishedIds.length > 0) || (waiter.mode === "all" && finishedIds.length === waiter.ids.size)) {
				const selectedIds = waiter.mode === "any" ? [finishedIds[0]] : finishedIds;
				const staleIds = selectedIds.filter((id) => agents.get(id)?.runSeq !== waiter.runSeqs[id]);
				completionWaiters.delete(waiter);
				waiter.resolve({ completedIds: selectedIds.filter((id) => !staleIds.includes(id)), staleIds });
			}
		}
	}

	/** Computes next agent ID: 1 when empty, else max(existing) + 1. Hidden agents retain their IDs. */
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

	function resolveWaitTargetIds(ids?: number[]): number[] {
		return ids && ids.length > 0
			? ids
			: Array.from(agents.values()).filter((agent) => agent.status === "running").map((agent) => agent.id);
	}

	function findMissingAgentIds(ids: number[]): number[] {
		return ids.filter((id) => !agents.has(id));
	}

	async function waitForAgents(
		targetIds: number[],
		mode: "any" | "all",
		signal?: AbortSignal,
		timeoutMs = AGENT_JOIN_TIMEOUT_MS,
	): Promise<{ status: "done" | "timeout" | "cancelled"; completedIds: number[]; staleIds: number[]; runSeqs: Record<number, number> }> {
		const runSeqs = Object.fromEntries(targetIds.map((id) => [id, agents.get(id)?.runSeq ?? 0]));
		const isFinished = (id: number) => {
			const state = agents.get(id);
			return !state || state.runSeq !== runSeqs[id] || state.status !== "running";
		};
		const finishedIds = targetIds.filter(isFinished);
		if (targetIds.length === 0 || (mode === "any" && finishedIds.length > 0) || (mode === "all" && finishedIds.length === targetIds.length)) {
			const selectedIds = mode === "any" ? finishedIds.slice(0, 1) : finishedIds;
			const staleIds = selectedIds.filter((id) => agents.get(id)?.runSeq !== runSeqs[id]);
			return { status: "done", completedIds: selectedIds.filter((id) => !staleIds.includes(id)), staleIds, runSeqs };
		}

		return await new Promise((resolve) => {
			let timeoutId: ReturnType<typeof setTimeout>;
			let settled = false;
			const finish = (result: { status: "done" | "timeout" | "cancelled"; completedIds: number[]; staleIds: number[] }) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutId);
				signal?.removeEventListener("abort", onAbort);
				completionWaiters.delete(waiter);
				resolve({ ...result, runSeqs });
			};
			let waiter: {
				ids: Set<number>;
				runSeqs: Record<number, number>;
				mode: "any" | "all";
				resolve: (result: { completedIds: number[]; staleIds: number[] }) => void;
			};
			const onAbort = () => finish({ status: "cancelled", completedIds: [], staleIds: [] });
			waiter = {
				ids: new Set(targetIds),
				runSeqs,
				mode,
				resolve: ({ completedIds, staleIds }) => finish({ status: "done", completedIds, staleIds }),
			};
			if (signal?.aborted) {
				resolve({ status: "cancelled", completedIds: [], staleIds: [], runSeqs });
				return;
			}
			completionWaiters.add(waiter);
			timeoutId = setTimeout(() => finish({ status: "timeout", completedIds: [], staleIds: [] }), timeoutMs);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	function finalizeJoinSuccess(
		state: SubAgentState,
		params: { format?: "summary only" | "full output"; artifact?: boolean },
		ctx: ExtensionContext,
	): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
		const key = runKey(state.id, state.runSeq);
		const completion = readCompletionEnvelope(state.sessionFile, state.runSeq);
		let resultText = completion?.finalText || state.lastAssistantText;

		if (!resultText && state.sessionFile && state.runSeq === 1) {
			const terminal = extractTerminalResultFromFile(state.sessionFile);
			if (terminal.kind === "text") resultText = terminal.text || "";
			else if (terminal.kind === "error") resultText = `Agent finished without final answer.\nError: ${terminal.error}`;
			else if (terminal.kind === "tool-only") resultText = `Agent finished task via tools but produced no final text summary. Check the session (/aenter ${state.id}) for details.`;
		}

		if (!resultText) {
			if (completion?.outcome === "tool-only") {
				resultText = `Agent finished task via tools but produced no final text summary. Check the session (/aenter ${state.id}) for details.`;
			} else if (completion?.outcome === "interrupted") {
				resultText = `Agent was interrupted before producing a final text summary.`;
			} else {
				resultText = state.sessionFile
					? `(agent produced no text output; use /aenter ${state.id} to view conversation)`
					: "(agent produced no text output)";
			}
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
				summary: completion?.finalText
					? completion.finalText.split("\n\n")[0]?.slice(0, 200)
					: state.lastAssistantText
						? state.lastAssistantText.split("\n\n")[0]?.slice(0, 200)
						: resultText.split("\n\n")[0]?.slice(0, 200),
				status: completion?.status ?? state.status,
				turnCount: completion?.turnCount ?? state.turnCount,
				toolCount: completion?.toolCount ?? state.toolCount,
				truncated: formatted.truncated,
				originalLength: formatted.originalLength,
				sessionFile: state.sessionFile,
				completionFile: completion ? state.completionFile ?? undefined : undefined,
				completionOutcome: completion?.outcome,
				completionExitCode: completion?.exitCode,
				artifact: Boolean(artifactPath),
				artifactPath,
				fullOutputPath: artifactPath,
				autoArtifact: isAutoArtifact,
			},
		};
	}

	function finalizeJoinResult(
		state: SubAgentState,
		params: { format?: "summary only" | "full output"; artifact?: boolean },
		ctx: ExtensionContext,
	): { content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown>; isError?: boolean } {
		const completion = readCompletionEnvelope(state.sessionFile, state.runSeq);
		if (state.timedOut || state.killed || completion?.outcome === "interrupted") {
			const partialText = completion?.partialText || state.currentStreamText || state.lastAssistantText;
			const shouldPersist = params.artifact || partialText.length > MAX_FULL_OUTPUT;
			const artifactPath = shouldPersist ? persistAgentArtifact(ctx.cwd || process.cwd(), state.id, partialText) : undefined;
			const formatted = formatAgentOutputDetailed(partialText, params.format);
			const canContinue = state.status !== "running" && !state.proc && existsSync(state.sessionFile);
			const elapsedMs = completion?.elapsedMs ?? state.elapsed;
			const reason = state.timedOut ? `runtime budget exceeded (${state.runtimeBudgetMs}ms)` : "process stopped";
			state.resultJoined = true;
			joinedRuns.add(runKey(state.id, state.runSeq));
			return {
				content: [{ type: "text", text: `Agent #${state.id} interrupted: ${reason}. Work is incomplete and unverified.\nElapsed: ${Math.round(elapsedMs / 1000)}s; tools: ${state.toolCount}; last tool: ${state.lastTool?.name ?? "none"}.\nSession: ${state.sessionFile}${state.lastErrorMessage ? `\nLast API/Model error: ${state.lastErrorMessage}` : ""}${partialText ? `\n\nPartial output (not a final result):\n${formatted.text}` : "\nNo partial text was captured; inspect files and the session."}${artifactPath ? `\nFull partial output: ${artifactPath}` : ""}\n\n${canContinue ? `Inspect existing changes and tool effects, then explicitly agent_continue(${state.id}) if appropriate.` : "Wait for process exit before continuing; the session file must still exist."}` }],
				details: {
					runSeq: state.runSeq, status: state.status, completionOutcome: "interrupted",
					completionExitCode: completion?.exitCode, elapsedMs, runtimeBudgetMs: state.runtimeBudgetMs,
					interruptionReason: completion?.interruptionReason ?? state.interruptionReason,
					lastTool: completion?.lastTool ?? state.lastTool, lastActivityAt: completion?.lastActivityAt ?? state.lastActivityAt,
					lastError: completion?.lastError ?? state.lastErrorMessage, canContinue,
					truncated: formatted.truncated, sessionFile: state.sessionFile, completionFile: state.completionFile,
					artifact: Boolean(artifactPath), artifactPath, fullOutputPath: artifactPath,
				},
				isError: true,
			};
		}
		if (state.status === "running") {
			return {
				content: [{ type: "text", text: `Agent #${state.id} is still running.` }],
				isError: true,
			};
		}
		if ((completion?.status ?? state.status) === "error") {
			const errDetails = state.stderrLines.length > 0
				? `\n\nStderr:\n${state.stderrLines.join("\n")}`
				: "";
			const completionErr = completion?.lastError ? `\n\nLast API/Model error: ${completion.lastError}` : "";
			const lastErr = completionErr || (state.lastErrorMessage ? `\n\nLast API/Model error: ${state.lastErrorMessage}` : "");
			return {
				content: [{
					type: "text",
					text: `Agent #${state.id} finished with an error.${lastErr}${errDetails}${(completion?.finalText || state.lastAssistantText) ? `\n\nPartial output:\n${completion?.finalText || state.lastAssistantText}` : ""}`,
				}],
				details: {
					runSeq: completion?.runSeq ?? state.runSeq,
					completionOutcome: completion?.outcome,
					completionExitCode: completion?.exitCode,
					completionFile: state.completionFile,
					sessionFile: state.sessionFile,
				},
				isError: true,
			};
		}
		const result = finalizeJoinSuccess(state, params, ctx);
		result.details.runSeq = completion?.runSeq ?? state.runSeq;
		return result;
	}

	function joinMultipleAgents(
		completedIds: number[],
		params: { format?: "summary only" | "full output"; artifact?: boolean },
		ctx: ExtensionContext,
	): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean } {
		const results = completedIds
			.map((id) => agents.get(id))
			.filter((state): state is SubAgentState => Boolean(state))
			.map((state) => ({ id: state.id, result: finalizeJoinResult(state, params, ctx) }));
		const hasError = results.some(({ result }) => result.isError === true);
		const text = results.map(({ id, result }) => {
			const body = result.content[0]?.text ?? "";
			return `#${id}\n${body}`;
		}).join("\n\n");
		return {
			content: [{ type: "text", text }],
			details: {
				joinedIds: results.map(({ id }) => id),
				count: results.length,
				format: params.format,
			},
			...(hasError ? { isError: true } : {}),
		};
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
		const visibleAgents = Array.from(agents.values()).filter((state) => !state.widgetHidden || state.status === "running");
		const focusedId = getFocusedAgentId(visibleAgents);
		for (const state of visibleAgents) {
			const id = state.id;
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
	const runtimeTimers = new Map<number, ReturnType<typeof setTimeout>>();
	function killAllAgents(): void {
		for (const state of agents.values()) {
			const proc = state.proc;
			if (state.status !== "running") continue;
			state.killed = true;
			state.interruptionReason ??= "parent_shutdown";
			state.elapsed = Math.max(0, Date.now() - state.startTime);
			state.status = "error";
			state.proc = undefined;
			const timer = runtimeTimers.get(state.id);
			if (timer) clearTimeout(timer);
			runtimeTimers.delete(state.id);
			state.completionFile = persistCompletionEnvelope(state, null);
			if (proc) {
				killProcess(proc);
				scheduleForceKill(proc);
			}
		}
		settleCompletionWaiters();
	}

	function killAgent(state: SubAgentState): boolean {
		const proc = state.proc;
		if (!proc || state.status !== "running") return false;
		state.killed = true;
		state.interruptionReason ??= "user_kill";
		state.elapsed = Math.max(0, Date.now() - state.startTime);
		state.status = "error";
		state.proc = undefined;
		const timer = runtimeTimers.get(state.id);
		if (timer) clearTimeout(timer);
		runtimeTimers.delete(state.id);
		state.completionFile = persistCompletionEnvelope(state, null);
		killProcess(proc);
		scheduleForceKill(proc);
		settleCompletionWaiters();
		return true;
	}

	async function runAgent(state: SubAgentState, toolList: string[], model?: string, onComplete?: () => void) {
		toolList = canonicalizeToolList(toolList);
		state.tools = toolList.join(",");
		const currentRunSeq = state.runSeq;
		const key = runKey(state.id, currentRunSeq);
		const isCurrentRun = () => agents.get(state.id) === state && state.runSeq === currentRunSeq && state.status === "running";
		const notifyCompletion = () => {
			if (agents.get(state.id) !== state || state.runSeq !== currentRunSeq || (state.killed && !state.timedOut)) return;
			const mode = state.notifyMode ?? "ui";
			if (mode === "off" || !activeCtx) return;
			activeCtx.ui.notify(`Agent #${state.id} [${state.name}] ${state.status}!`, state.status === "done" ? "success" : "error");
			if (mode !== "turn" || joinWaiters.has(key) || joinedRuns.has(key)) return;
			const tid = setTimeout(() => {
				pendingNotifications.delete(key);
				if (agents.get(state.id) !== state || state.runSeq !== currentRunSeq || joinWaiters.has(key) || joinedRuns.has(key) || !activeCtx) return;
				pi.sendMessage({
					customType: "agent-notification",
					content: `📢 Agent #${state.id} [${state.name}] ${state.status === "done" ? "completed its task" : state.timedOut ? "was interrupted: runtime budget exceeded" : "finished with an error"}.\n\nUse agent_join with id: ${state.id} to retrieve the result.`,
					details: { agentId: state.id, runSeq: currentRunSeq, status: state.status, timedOut: state.timedOut },
					display: true,
				}, { deliverAs: "followUp", triggerTurn: true });
			}, AGENT_NOTIFICATION_DELAY_MS);
			pendingNotifications.set(key, tid);
		};
		let settled = false;
		const settleFailure = (message: string) => {
			if (settled || !isCurrentRun()) return;
			settled = true;
			state.status = "error";
			state.elapsed = Math.max(0, Date.now() - state.startTime);
			state.lastActivityAt = Date.now();
			state.lastErrorMessage = message;
			state.stderrLines.push(message);
			state.completionFile = persistCompletionEnvelope(state, null);
			state.proc = undefined;
			updateAllWidgets();
			settleCompletionWaiters();
			onComplete?.();
			notifyCompletion();
		};

		// Verify session file exists before spawning (retry for Windows FS delay)
		let found = false;
		try {
			for (let attempt = 0; attempt <= SESSION_FILE_RETRY_ATTEMPTS; attempt++) {
				if (!isCurrentRun()) return;
				if (existsSync(path.resolve(state.sessionFile))) {
					found = true;
					break;
				}
				if (attempt < SESSION_FILE_RETRY_ATTEMPTS) {
					await new Promise((r) => setTimeout(r, SESSION_FILE_RETRY_DELAY_MS));
				}
			}
		} catch (err) {
			settleFailure(`Could not verify session file ${state.sessionFile}: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		if (!isCurrentRun()) return;
		if (!found) {
			settleFailure(`Session file not found: ${state.sessionFile}`);
			return;
		}

		let proc: ChildProcess;
		try {
			const cwd = activeCtx?.cwd || process.cwd();
			const extensions = resolveExtensions(toolList, import.meta.url);
			const phaseGuidance = buildPhaseGuidance(state.phase);
			proc = spawnPiProcess({
				task: `${phaseGuidance}${phaseGuidance ? "\n\n" : ""}${state.task}`,
				sessionFile: state.sessionFile,
				toolList,
				extensions,
				model,
				thinkingLevel: resolveThinkingLevel(state.tier),
				cwd,
				isContinuation: state.runSeq > 1,
				extraEnv: buildAllowedToolsEnv(toolList)
			});
		} catch (err) {
			settleFailure(`Could not start agent process: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}

		state.proc = proc;
		let buf = "";
		ensureTimer();

		const budgetMs = state.runtimeBudgetMs ?? 0;
		const timeoutId = budgetMs > 0 ? setTimeout(() => {
			if (isCurrentRun() && state.proc === proc) {
				runtimeTimers.delete(state.id);
				state.timedOut = true;
				state.killed = true;
				state.interruptionReason = "runtime_budget";
				killProcess(proc);
				scheduleForceKill(proc);
			}
		}, budgetMs) : undefined;
		if (timeoutId) runtimeTimers.set(state.id, timeoutId);
		const isCurrentProcess = () => isCurrentRun() && state.proc === proc;
		const clearRunTimeout = () => {
			if (timeoutId !== undefined) clearTimeout(timeoutId);
			if (runtimeTimers.get(state.id) === timeoutId) runtimeTimers.delete(state.id);
		};

		// ── stdout: parse JSON events ─────────────────────────────────
		proc.stdout?.setEncoding("utf-8");
		proc.stdout?.on("data", (chunk: string) => {
			if (!isCurrentProcess()) return;
			buf += chunk;
			const lines = buf.split("\n");
			buf = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				state.lastActivityAt = Date.now();
				try { parseAgentEvent(JSON.parse(line), state); } catch { /* skip malformed JSON lines */ }
			}
		});

		// ── stderr: capture for debugging ────────────────────────────
		proc.stderr?.setEncoding("utf-8");
		proc.stderr?.on("data", (chunk: string) => {
			if (!isCurrentProcess()) return;
			const isUvClosingNoise = (line: string) =>
				line.includes("UV_HANDLE_CLOSING") ||
				line.includes("src\\win\\async.c") ||
				line.includes("src/win/async.c");
			for (const line of chunk.split("\n").filter(l => l.trim() && !isUvClosingNoise(l))) {
				state.lastActivityAt = Date.now();
				state.stderrLines.push(line);
				if (state.stderrLines.length > MAX_STDERR_LINES) state.stderrLines.shift();
			}
		});

		// ── close: finalize state ─────────────────────────────────────
		proc.on("close", (code) => {
			if (!isCurrentProcess() || settled) return;
			settled = true;
			clearRunTimeout();
			for (const line of buf.split("\n").filter((l) => l.trim())) {
				state.lastActivityAt = Date.now();
				try { parseAgentEvent(JSON.parse(line), state); } catch {}
			}
			state.status = (!state.killed && code === 0) ? "done" : "error";
			if (process.platform === "win32") {
				try { proc.stdout?.destroy(); } catch {}
				try { proc.stderr?.destroy(); } catch {}
			}
			const finishedAt = Date.now();
			state.elapsed = Math.max(0, finishedAt - state.startTime);
			state.proc = undefined;
			state.completionFile = persistCompletionEnvelope(state, code ?? null);
			updateAllWidgets();
			settleCompletionWaiters();
			onComplete?.();
			notifyCompletion();
		});

		// ── error: spawn failed ───────────────────────────────────────
		proc.on("error", (err: Error) => {
			if (!isCurrentProcess() || settled) return;
			clearRunTimeout();
			try { proc.kill("SIGTERM"); } catch {}
			settleFailure(`Spawn error: ${err.message}`);
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
		description: "Wait until ANY of the specified agents finish. Returns immediately if one is already done. Set join=true to return the completed result directly.",
		parameters: AgentWaitParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const targetIds = resolveWaitTargetIds(params.ids);
			if (targetIds.length === 0) {
				return { content: [{ type: "text", text: "No running agents to wait for." }] };
			}
			const missingIds = findMissingAgentIds(targetIds);
			if (missingIds.length > 0) {
				return { content: [{ type: "text", text: `Error: Unknown agent id(s): ${missingIds.join(", ")}. Use agent_list to inspect active agents.` }], isError: true };
			}

			const invalid = validateTimeout(params.timeoutMs, "timeoutMs");
			if (invalid) return invalid;
			const waitResult = await waitForAgents(targetIds, "any", signal, params.timeoutMs ?? AGENT_JOIN_TIMEOUT_MS);
			if (waitResult.status === "cancelled") {
				return { content: [{ type: "text", text: "Wait cancelled by user; agents were not stopped." }], isError: true };
			}
			if (waitResult.status === "timeout") return waitTimeoutResult(targetIds, waitResult.runSeqs);
			const staleIds = targetIds.filter((id) => agents.get(id)?.runSeq !== waitResult.runSeqs[id]);
			if (staleIds.length) return staleWaitResult(staleIds);
			if (params.join) {
				for (const id of waitResult.completedIds) joinWaiters.add(runKey(id, agents.get(id)?.runSeq ?? 0));
				try {
					return joinMultipleAgents(waitResult.completedIds, { format: params.format, artifact: params.artifact }, ctx);
				} finally {
					for (const id of waitResult.completedIds) {
						const key = runKey(id, agents.get(id)?.runSeq ?? 0);
						joinWaiters.delete(key);
						const tid = pendingNotifications.get(key);
						if (tid !== undefined) {
							clearTimeout(tid);
							pendingNotifications.delete(key);
						}
					}
				}
			}

			const text = waitResult.completedIds.map((id) => describeCompletedAgent(id) ?? `Agent #${id} has finished.`).join("\n");
			return { content: [{ type: "text", text }] };
		},
	});

	if (isAllowed("agent_wait_all")) pi.registerTool({
		name: "agent_wait_all",
		label: "Wait for All Agents",
		description: "Wait until ALL specified agents finish. Set join=true to return joined results in one step.",
		parameters: AgentWaitParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const targetIds = resolveWaitTargetIds(params.ids);
			if (targetIds.length === 0) {
				return { content: [{ type: "text", text: "No running agents to wait for." }] };
			}
			const missingIds = findMissingAgentIds(targetIds);
			if (missingIds.length > 0) {
				return { content: [{ type: "text", text: `Error: Unknown agent id(s): ${missingIds.join(", ")}. Use agent_list to inspect active agents.` }], isError: true };
			}

			const invalid = validateTimeout(params.timeoutMs, "timeoutMs");
			if (invalid) return invalid;
			const waitResult = await waitForAgents(targetIds, "all", signal, params.timeoutMs ?? AGENT_JOIN_TIMEOUT_MS);
			if (waitResult.status === "cancelled") {
				return { content: [{ type: "text", text: "Wait cancelled by user; agents were not stopped." }], isError: true };
			}
			if (waitResult.status === "timeout") return waitTimeoutResult(targetIds, waitResult.runSeqs);
			const staleIds = targetIds.filter((id) => agents.get(id)?.runSeq !== waitResult.runSeqs[id]);
			if (staleIds.length) return staleWaitResult(staleIds);
			if (params.join) {
				for (const id of waitResult.completedIds) joinWaiters.add(runKey(id, agents.get(id)?.runSeq ?? 0));
				try {
					return joinMultipleAgents(waitResult.completedIds, { format: params.format, artifact: params.artifact }, ctx);
				} finally {
					for (const id of waitResult.completedIds) {
						const key = runKey(id, agents.get(id)?.runSeq ?? 0);
						joinWaiters.delete(key);
						const tid = pendingNotifications.get(key);
						if (tid !== undefined) {
							clearTimeout(tid);
							pendingNotifications.delete(key);
						}
					}
				}
			}

			const lines = waitResult.completedIds.map((id) => `#${id} ${agents.get(id)?.status.toUpperCase() ?? "UNKNOWN"}`).join("\n");
			return { content: [{ type: "text", text: `All specified agents have finished:\n${lines}` }] };
		},
	});

	if (isAllowed("agent_spawn")) pi.registerTool({
		name: "agent_spawn",
		label: "Spawn Agent",
		description: "PRIMARY delegation tool. Spawn a background sub-agent for one bounded deliverable; returns ID immediately. Persistent session supports follow-up. No execution deadline unless runtimeBudgetMs > 0. Tier selects model/thinking; omitted inherits parent model with thinking off. Read, glob, grep, find, ls always included. Prefer over disposable task for non-trivial work.",
		parameters: AgentSpawnParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			activeCtx = ctx;
			const invalid = validateTimeout(params.runtimeBudgetMs, "runtimeBudgetMs");
			if (invalid) return invalid;
			const delegation = validateDelegationPrompt({ text: params.task, tags: params.tags, mode: "spawn" });
			if (!delegation.ok) {
				return {
					content: [{ type: "text", text: delegation.errors.join("\n") }],
					isError: true,
					details: { warnings: delegation.warnings },
				};
			}
			const cwd = ctx.cwd || process.cwd();
			const id = nextAgentId();
			const toolList = resolveToolsParam(params.tags);
			const parentModel = currentModelString(ctx.model);
			const model = resolveModel({ model: params.model, tier: params.tier, tiers: modelTiers, fallback: parentModel });
			const resolvedTier = params.tier ?? reverseLookupTier(model ?? "", modelTiers);
			const phase = normalizePhase(params.phase);
			let spawnMode = normalizeSpawnMode(params.mode);
			const forkContextMode = normalizeForkContextMode(params.context);
			const phaseWarnings: string[] = [];
			if (spawnMode === "fork" && forkContextMode === "none") {
				spawnMode = "fresh";
				phaseWarnings.push("Fork mode requested without context=recent; downgraded to fresh mode.");
			}
			if (spawnMode === "fork" && (params.contextTurns ?? 6) < 2) {
				phaseWarnings.push("Fork mode with fewer than 2 turns may provide too little context.");
			}
			const forkContext = buildForkContextPrompt(ctx, {
				mode: spawnMode,
				contextMode: forkContextMode,
				turns: params.contextTurns,
				maxChars: params.contextMaxChars,
			});
			const effectiveTask = forkContext
				? `${forkContext}\n## Delegated task\n${params.task}`
				: params.task;
			const state: SubAgentState = {
				id,
				name: params.name || `agent-${id}`,
				status: "running",
				resultJoined: false,
				task: effectiveTask,
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
				runtimeBudgetMs: params.runtimeBudgetMs ?? 0,
				stderrLines: [],
				tools: toolList.join(","),
				tags: params.tags,
				model,
				tier: resolvedTier,
				runSeq: 1,
				notifyMode: params.notify || "ui",
				lastActivityAt: Date.now(),
				completionFile: undefined,
				phase,
				spawnMode,
				forkContextMode,
			};
			agents.set(id, state);

			runAgent(state, toolList, model);
			updateAllWidgets();

			const metaParts = formatAgentMetaBracketed({ tier: resolvedTier, model, tags: params.tags, phase, spawnMode, forkContextMode });
			const allWarnings = [...delegation.warnings, ...phaseWarnings];
			const warningSuffix = allWarnings.length > 0
				? `\nWarnings:\n- ${allWarnings.join("\n- ")}`
				: "";
			const phaseSuffix = phase ? `\nPhase: ${phase}` : "";
			const modeSuffix = spawnMode === "fork" ? `\nSpawn mode: fork (${forkContextMode})` : "";
			const output = `Agent #${id} [${state.name}]${metaParts ? ` ${metaParts}` : ""} spawned. Use agent_join(${id}) for result.${phaseSuffix}${modeSuffix}${warningSuffix}`;
			return { content: [{ type: "text", text: output }], details: { format: params.format, warnings: allWarnings, phase, spawnMode, forkContextMode } };
		},
	});

	if (isAllowed("agent_join")) pi.registerTool({
		name: "agent_join",
		label: "Join Agent",
		description: "Wait for sub-agent output, up to timeoutMs (default 20 min). Timeout returns still-running status without stopping the agent; wait again later. Retrieve every relevant delegated result. Optional artifact saves full output.",
		parameters: AgentJoinParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const state = agents.get(params.id);
			if (!state) {
				return {
					content: [{ type: "text", text: `Error: No agent with id ${params.id}. Use agent_list to see active agents.` }],
					isError: true,
				};
			}

			const invalid = validateTimeout(params.timeoutMs, "timeoutMs");
			if (invalid) return invalid;
			const expectedRunSeq = state.runSeq;
			const key = runKey(state.id, expectedRunSeq);
			joinWaiters.add(key);
			try {
				const waitResult = await waitForAgents([params.id], "all", signal, params.timeoutMs ?? AGENT_JOIN_TIMEOUT_MS);
				if (waitResult.status === "cancelled") {
					return {
						content: [{ type: "text", text: `agent_join cancelled by user (Escape pressed). Agent #${params.id} is still running.` }],
						isError: true,
					};
				}
				if (state.runSeq !== expectedRunSeq || agents.get(state.id) !== state) return staleWaitResult([state.id]);
				if (waitResult.status === "timeout") return waitTimeoutResult([state.id], waitResult.runSeqs);
				return finalizeJoinResult(state, { format: params.format, artifact: params.artifact }, ctx);
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

	if (isAllowed("agent_result")) pi.registerTool({
		name: "agent_result",
		label: "Get Agent Result",
		description: "Read the completion result of a finished sub-agent without waiting. Use this after agent_join or when agent_list shows a finished agent. Optionally target a specific runSeq.",
		parameters: AgentResultParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const state = agents.get(params.id);
			if (!state) {
				return {
					content: [{ type: "text", text: `Error: No agent with id ${params.id}. Use agent_list to see active agents.` }],
					isError: true,
				};
			}
			const targetRunSeq = params.runSeq ?? state.runSeq;
			if (state.status === "running" && targetRunSeq === state.runSeq) {
				return {
					content: [{ type: "text", text: `Agent #${params.id} run ${targetRunSeq} is still running. Wait for it to finish before requesting its result.` }],
					isError: true,
				};
			}
			const completion = readCompletionEnvelope(state.sessionFile, targetRunSeq);
			if (!completion) {
				if (targetRunSeq !== state.runSeq) return { content: [{ type: "text", text: `No completion recorded for agent #${state.id} run ${targetRunSeq}.` }], details: { runSeq: targetRunSeq }, isError: true };
				return finalizeJoinResult(state, { format: params.format, artifact: params.artifact }, ctx);
			}
			if (completion.outcome === "interrupted" && targetRunSeq === state.runSeq) {
				return finalizeJoinResult(state, { format: params.format, artifact: params.artifact }, ctx);
			}

			let resultText = completion.outcome === "interrupted"
				? `Interrupted run; incomplete and unverified.\n\nPartial output:\n${completion.partialText || "No partial text was captured."}`
				: completion.finalText;
			if (!resultText) {
				if (completion.outcome === "tool-only") resultText = `Agent finished task via tools but produced no final text summary. Check the session (/aenter ${state.id}) for details.`;
				else if (completion.outcome === "interrupted") resultText = `Agent was interrupted before producing a final text summary.`;
				else if (completion.outcome === "error") resultText = completion.lastError ? `Agent finished with an error.\nError: ${completion.lastError}` : `Agent finished with an error.`;
				else resultText = state.sessionFile ? `(agent produced no text output; use /aenter ${state.id} to view conversation)` : "(agent produced no text output)";
			}

			const isAutoArtifact = resultText.length > MAX_FULL_OUTPUT;
			const shouldPersist = params.artifact || isAutoArtifact;
			const previewFormat = shouldPersist && !params.format ? "summary only" : params.format;
			const formatted = formatAgentOutputDetailed(resultText, previewFormat);
			const artifactPath = shouldPersist ? persistAgentArtifact(ctx.cwd || process.cwd(), state.id, resultText) : undefined;
			return {
				content: [{
					type: "text",
					text: artifactPath
						? `${formatted.text}\n\n${formatted.truncated ? "Output truncated." : ""} Full output saved to:\n${artifactPath}`
						: formatted.text,
				}],
				details: {
					format: previewFormat,
					runSeq: completion.runSeq,
					status: completion.status,
					outcome: completion.outcome,
					exitCode: completion.exitCode,
					turnCount: completion.turnCount,
					toolCount: completion.toolCount,
					elapsedMs: completion.elapsedMs,
					lastTool: completion.lastTool, lastError: completion.lastError,
					interruptionReason: completion.interruptionReason, runtimeBudgetMs: completion.runtimeBudgetMs,
					lastActivityAt: completion.lastActivityAt,
					sessionFile: completion.sessionFile,
					completionFile: getCompletionFilePath(state.sessionFile, targetRunSeq),
					artifact: Boolean(artifactPath),
					artifactPath,
					fullOutputPath: artifactPath,
					autoArtifact: isAutoArtifact,
				},
				isError: completion.status === "error",
			};
		},
	});

	if (isAllowed("agent_continue")) pi.registerTool({
		name: "agent_continue",
		label: "Continue Agent",
		description: "Continue a stopped sub-agent with new instructions and saved history; returns immediately. After interruption inspect changes/tool effects before resuming. runtimeBudgetMs inherits the previous budget; 0 clears it. Required: id, prompt. Optional tags, tier, model, notify, format, phase. Read, glob, grep, find, ls always included.",
		parameters: AgentContinueParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			activeCtx = ctx;
			const invalid = validateTimeout(params.runtimeBudgetMs, "runtimeBudgetMs");
			if (invalid) return invalid;
			const delegation = validateDelegationPrompt({ text: params.prompt, tags: params.tags, mode: "continue" });
			if (!delegation.ok) {
				return {
					content: [{ type: "text", text: delegation.errors.join("\n") }],
					isError: true,
					details: { warnings: delegation.warnings },
				};
			}
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
			if (state.proc) {
				return { content: [{ type: "text", text: `Agent #${state.id} process has not exited; wait before continuing.` }], isError: true };
			}
			if (!existsSync(state.sessionFile)) {
				return {
					content: [{ type: "text", text: `Error: Session file for agent #${params.id} not found. Cannot continue.` }],
					isError: true,
				};
			}

			beginAgentRun(state, params.prompt, params.notify, params.runtimeBudgetMs);
			const requestedPhase = normalizePhase(params.phase);
			const phaseValidation = validatePhaseTransition(state.phase, requestedPhase);
			state.phase = requestedPhase ?? state.phase;

			const toolList = params.tags
				? resolveToolsParam(params.tags)
				: state.tools.split(",").map((t) => t.trim()).filter(Boolean);
			state.tools = toolList.join(",");
			state.tags = params.tags ?? state.tags;

			// Resolve model: explicit param > tier param > previously set model > parent model
			const parentModel = currentModelString(ctx.model);
			const model = resolveModel({ model: params.model, tier: params.tier, tiers: modelTiers, fallback: state.model ?? parentModel });
			state.model = model;
			const inferredTier = reverseLookupTier(model ?? "", modelTiers);
			state.tier = params.tier ?? inferredTier ?? (params.model ? undefined : state.tier);

			agents.set(params.id, state);
			updateAllWidgets();

			runAgent(state, toolList, model);

			const metaParts = formatAgentMetaBracketed({ tier: state.tier, model, tags: state.tags, phase: state.phase, spawnMode: state.spawnMode, forkContextMode: state.forkContextMode });
			const allWarnings = [...delegation.warnings, ...phaseValidation.warnings];
			const warningSuffix = allWarnings.length > 0
				? `\nWarnings:\n- ${allWarnings.join("\n- ")}`
				: "";
			const phaseSuffix = state.phase ? `\nPhase: ${state.phase}` : "";
			const output = `Agent #${params.id} [${state.name}]${metaParts ? ` ${metaParts}` : ""} continuing (Turn ${state.turnCount}). Use agent_join(${params.id}) for result.${phaseSuffix}${warningSuffix}`;
			return { content: [{ type: "text", text: output }], details: { format: params.format, warnings: allWarnings, phase: state.phase } };
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
				const suffix = s.timedOut ? " [runtime budget exceeded]" : s.killed ? " [killed]" : "";
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
							if (agent.proc || !existsSync(agent.sessionFile)) {
								ctx.ui.notify(`Cannot chat with agent #${agent.id} (process exiting or session missing).`, "error");
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
			if (state.proc) {
				ctx.ui.notify(`Agent #${id} process has not exited.`, "warning");
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
			if (state.proc) {
				ctx.ui.notify(`Agent #${id} process has not exited.`, "warning");
				return;
			}
			// Verify session file exists
			if (!existsSync(state.sessionFile)) {
				ctx.ui.notify(`Agent #${id} session file not found. Cannot continue.`, "error");
				return;
			}

			beginAgentRun(state, prompt);

			const toolList = state.tools
				? state.tools.split(",").map((t) => t.trim()).filter(Boolean)
				: resolveTagsToTools("Bash");
			state.tools = toolList.join(",");

			updateAllWidgets();

			const model = state.model ?? currentModelString(ctx.model);
			state.model = model;
			runAgent(state, toolList, model);

			ctx.ui.notify(`Agent #${id} [${state.name}] continuing (Turn ${state.turnCount})…`, "info");
		},
	});

	pi.registerCommand("aclear", {
		description: "Hide finished/errored agent widgets without deleting agents, results or history",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			let count = 0;
			for (const [id, state] of agents) {
				if (state.status !== "running" && !state.widgetHidden) {
					state.widgetHidden = true;
					ctx.ui.setWidget(`agent-${id}`, undefined);
					count++;
				}
			}
			ctx.ui.notify(
				count > 0
					? `Hidden ${count} agent widget${count !== 1 ? "s" : ""}. Agents and results remain available via /agents and agent tools.`
					: "No finished agent widgets to hide.",
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
		if (process.env[ALLOWED_TOOLS_ENV]) return undefined;
		return {
			systemPrompt: event.systemPrompt + "\n\n" + ORCHESTRATOR_GUIDANCE,
		};
	});

	pi.on("session_start", async (_e, ctx) => {
		for (const timer of pendingNotifications.values()) clearTimeout(timer);
		pendingNotifications.clear();
		activeCtx = ctx;
		modelTiers = loadModelTiers(ctx.cwd);
		// Retain interrupted diagnostics and release old run deadlines before replacing state.
		killAllAgents();
		for (const timer of runtimeTimers.values()) clearTimeout(timer);
		runtimeTimers.clear();
		for (const id of agents.keys()) ctx.ui.setWidget(`agent-${id}`, undefined);
		agents.clear();
		stopTimer();
		ctx.ui.notify("BaseAgents (Orchestration) Loaded", "info");
	});

	pi.on("session_shutdown", async () => {
		stopTimer();
		for (const timer of pendingNotifications.values()) clearTimeout(timer);
		pendingNotifications.clear();
		activeCtx = undefined;
		killAllAgents();
		for (const state of agents.values()) {
			if (state.status !== "done") continue;
			const completions = Array.from({ length: state.runSeq }, (_, index) => readCompletionEnvelope(state.sessionFile, index + 1));
			// Keep the shared transcript if any earlier run failed or diagnostics are missing.
			if (completions.some((completion) => !completion || completion.status === "error" || completion.outcome === "interrupted")) continue;
			try { if (existsSync(state.sessionFile)) unlinkSync(state.sessionFile); } catch {}
			for (let runSeq = 1; runSeq <= state.runSeq; runSeq++) {
				try {
					const completionFile = getCompletionFilePath(state.sessionFile, runSeq);
					if (existsSync(completionFile)) unlinkSync(completionFile);
				} catch {}
			}
		}
	});
}
