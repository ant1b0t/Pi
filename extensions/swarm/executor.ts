// ============================================================================
// Swarm agent executor — адаптировано из oh-my-pi для Pi
//
// Запускает каждого агента роя как Pi-подпроцесс через spawnPiProcess.
// В отличие от ompi (где runSubprocess), здесь используется собственная
// инфраструктура Pi: spawnPiProcess + parseAgentEvent из agent-runner/agent-events.
// ============================================================================

import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { SwarmAgent } from "./schema";
import type { StateTracker } from "./state";
import {
	spawnPiProcess,
	resolveExtensions,
	resolveToolsParam,
	makeSessionFile,
	killProcess,
	scheduleForceKill,
	AGENT_JOIN_TIMEOUT_MS,
	type FormattedAgentOutput,
	formatAgentOutputDetailed,
} from "../base/agent-runner.ts";
import { parseAgentEvent, type MutableAgentState } from "../base/agent-events.ts";

// ============================================================================
// Types
// ============================================================================

export interface SwarmAgentResult {
	agentName: string;
	status: "completed" | "failed" | "aborted";
	exitCode: number;
	output: string;
	stderr: string;
	error?: string;
	durationMs: number;
	modelUsed: string;
}

export interface SwarmExecutorOptions {
	workspace: string;
	swarmName: string;
	iteration: number;
	modelOverride?: string;
	tags?: string;
	signal?: AbortSignal;
	stateTracker: StateTracker;
	/** Caller's import.meta.url for resolving extensions */
	callerUrl: string;
}

// ============================================================================
// Formatting helpers
// ============================================================================

/** Форматирует duration для логов. */
function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	const m = Math.floor(s / 60);
	if (m > 0) return `${m}m ${s % 60}s`;
	return `${s}s`;
}

// ============================================================================
// executeSwarmAgent
// ============================================================================

/**
 * Execute a single swarm agent as a Pi subprocess.
 *
 * The agent receives:
 * - System prompt: built from role + extra_context
 * - Task: the full task instructions from the YAML
 * - Working directory: the swarm workspace
 * - Tags: "Bash" by default (read + write + bash)
 */
export async function executeSwarmAgent(
	agent: SwarmAgent,
	index: number,
	options: SwarmExecutorOptions,
): Promise<SwarmAgentResult> {
	const {
		workspace,
		swarmName,
		iteration,
		modelOverride,
		tags,
		signal,
		stateTracker,
		callerUrl,
	} = options;

	const startTime = Date.now();
	const toolList = resolveToolsParam(tags || "Bash");
	const extensions = resolveExtensions(toolList, callerUrl);
	const sessionFile = makeSessionFile(index, workspace, `swarm-${swarmName}`);

	const model = agent.model ?? modelOverride;

	await stateTracker.updateAgent(agent.name, {
		status: "running",
		iteration,
		startedAt: Date.now(),
	});
	await stateTracker.appendLog(agent.name, `Starting iteration ${iteration} (model: ${model || "default"})`);

	return new Promise((resolveResult) => {
		const proc: ChildProcess = spawnPiProcess({
			task: buildSystemPrompt(agent) + "\n\n---\n\n" + agent.task,
			sessionFile,
			toolList,
			extensions,
			model,
			cwd: workspace,
		});

		const agentState: MutableAgentState = {
			status: "running",
			modelUsed: model || "default",
			exitCode: -1,
		};

		let output = "";
		let stderr = "";
		let settled = false;

		const timeoutId = setTimeout(() => {
			if (settled) return;
			killProcess(proc);
			scheduleForceKill(proc);
		}, AGENT_JOIN_TIMEOUT_MS);

		const finish = async (status: SwarmAgentResult["status"], error?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);

			const durationMs = Date.now() - startTime;
			try { proc.kill("SIGTERM"); } catch {}
			scheduleForceKill(proc);

			await stateTracker.updateAgent(agent.name, {
				status: status === "completed" ? "completed" : "failed",
				completedAt: Date.now(),
				error,
			});
			await stateTracker.appendLog(
				agent.name,
				`Iteration ${iteration} ${status} (${formatDuration(durationMs)})${error ? `: ${error}` : ""}`,
			);

			resolveResult({
				agentName: agent.name,
				status,
				exitCode: agentState.exitCode,
				output,
				stderr,
				error,
				durationMs,
				modelUsed: agentState.modelUsed,
			});
		};

		proc.stdout?.setEncoding("utf-8");
		proc.stdout?.on("data", (chunk: string) => {
			output += chunk;
			for (const line of chunk.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const event = parseAgentEvent(trimmed);
					if (event) {
						Object.assign(agentState, event);
						if (event.modelUsed) agentState.modelUsed = event.modelUsed;
					}
				} catch {}
			}
		});

		proc.stderr?.setEncoding("utf-8");
		proc.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});

		proc.on("close", (code) => {
			agentState.exitCode = code ?? -1;
			const success = code === 0;
			finish(success ? "completed" : "failed", success ? undefined : `exit code ${code}`);
		});

		proc.on("error", (err) => {
			finish("failed", err.message);
		});

		if (signal) {
			signal.addEventListener("abort", () => {
				finish("aborted", "aborted by signal");
			}, { once: true });
		}
	});
}

// ============================================================================
// Helpers
// ============================================================================

function buildSystemPrompt(agent: SwarmAgent): string {
	const parts = [`You are a ${agent.role}.`];
	if (agent.extraContext) {
		parts.push(agent.extraContext);
	}
	return parts.join("\n\n");
}
