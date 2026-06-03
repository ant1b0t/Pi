// ============================================================================
// Swarm progress renderer — адаптировано из oh-my-pi
//
// Превращает SwarmState в массив строк для отображения в виджете.
// ============================================================================

import type { SwarmState } from "./state";

const STATUS_ICONS: Record<string, string> = {
	pending: "⚪",
	waiting: "🟡",
	running: "🔵",
	completed: "🟢",
	failed: "🔴",
};

const STATUS_LABELS: Record<string, string> = {
	idle: "Idle",
	running: "Running",
	completed: "Completed",
	failed: "Failed",
	aborted: "Aborted",
};

function formatTime(ms?: number): string {
	if (!ms) return "--:--";
	const totalSec = Math.floor(ms / 1000);
	const m = Math.floor(totalSec / 60);
	const s = totalSec % 60;
	return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatAgentDuration(startedAt?: number, completedAt?: number): string {
	if (!startedAt) return "";
	if (!completedAt) {
		const elapsed = Date.now() - startedAt;
		return ` (${formatTime(elapsed)})`;
	}
	return ` (${formatTime(completedAt - startedAt)})`;
}

export function renderSwarmProgress(state: SwarmState): string[] {
	const lines: string[] = [];

	// Header
	const pipelineIcon = state.status === "running" ? "🔄" : state.status === "completed" ? "✅" : "❌";
	lines.push(
		`${pipelineIcon} Swarm: ${state.name} [${STATUS_LABELS[state.status] ?? state.status}]`,
	);
	lines.push(`   Mode: ${state.mode} | Iteration: ${state.iteration + 1}/${state.targetCount}`);

	if (state.completedAt && state.startedAt) {
		lines.push(`   Elapsed: ${formatTime(state.completedAt - state.startedAt)}`);
	}

	lines.push("");

	// Agent list
	for (const [name, agent] of Object.entries(state.agents)) {
		const icon = STATUS_ICONS[agent.status] ?? "⚪";
		const duration = formatAgentDuration(agent.startedAt, agent.completedAt);
		const wave = agent.wave > 0 ? ` wave=${agent.wave + 1}` : "";
		lines.push(`   ${icon} ${name}: ${agent.status}${duration}${wave}`);
		if (agent.error) {
			lines.push(`      ⚠️ ${agent.error.slice(0, 80)}`);
		}
	}

	return lines;
}
