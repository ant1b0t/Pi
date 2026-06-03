// ============================================================================
// Swarm Extension — адаптировано из oh-my-pi/packages/swarm-extension
//
// Регистрирует:
// - /swarm run <file.yaml>   — выполнение swarm-пайплайна из YAML
// - /swarm status [name]     — статус текущего пайплайна
// - /swarm help              — справка
//
// YAML-формат совместим с oh-my-pi swarm extension.
// ============================================================================

import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { buildDependencyGraph, buildExecutionWaves, detectCycles } from "./dag";
import { PipelineController } from "./pipeline";
import { renderSwarmProgress } from "./render";
import { parseSwarmYaml, type SwarmDefinition, validateSwarmDefinition } from "./schema";
import { StateTracker } from "./state";

export default function swarmExtension(pi: ExtensionAPI): void {
	pi.registerCommand("swarm", {
		description: "Run a multi-agent swarm pipeline from YAML",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["run", "status", "help"];
			if (!prefix) return subcommands.map(s => ({ label: s, value: s }));
			return subcommands.filter(s => s.startsWith(prefix)).map(s => ({ label: s, value: s }));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0] ?? "help";

			switch (subcommand) {
				case "run": {
					const yamlPath = parts[1];
					if (!yamlPath) {
						ctx.ui.notify("Usage: /swarm run <path/to/pipeline.yaml>", "error");
						return;
					}
					await handleRun(yamlPath, ctx, pi);
					return;
				}
				case "status": {
					await handleStatus(parts[1], ctx);
					return;
				}
				default:
					ctx.ui.notify(
						[
							"Swarm — multi-agent pipeline orchestrator",
							"",
							"  /swarm run <file.yaml>     Run a pipeline",
							"  /swarm status [name]       Show pipeline status",
							"  /swarm help                Show this help",
						].join("\n"),
						"info",
					);
					return;
			}
		},
	});
}

// ============================================================================
// /swarm run
// ============================================================================

async function handleRun(
	yamlPath: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<void> {
	// 1. Resolve and read YAML
	const resolvedPath = path.isAbsolute(yamlPath) ? yamlPath : path.resolve(ctx.cwd, yamlPath);

	let content: string;
	try {
		content = readFileSync(resolvedPath, "utf-8");
	} catch {
		ctx.ui.notify(`Cannot read file: ${resolvedPath}`, "error");
		return;
	}

	// 2. Parse YAML
	let def: SwarmDefinition;
	try {
		def = parseSwarmYaml(content);
	} catch (err) {
		ctx.ui.notify(`YAML error: ${err instanceof Error ? err.message : String(err)}`, "error");
		return;
	}

	// 3. Validate
	const validationErrors = validateSwarmDefinition(def);
	if (validationErrors.length > 0) {
		ctx.ui.notify(
			`Validation errors:\n${validationErrors.map(e => `  - ${e}`).join("\n")}`,
			"error",
		);
		return;
	}

	// 4. Build DAG
	const deps = buildDependencyGraph(def);
	const cycleNodes = detectCycles(deps);
	if (cycleNodes) {
		ctx.ui.notify(
			`Cycle detected in agent dependencies: [${cycleNodes.join(", ")}]`,
			"error",
		);
		return;
	}
	const waves = buildExecutionWaves(deps);

	// 5. Resolve workspace (relative to YAML file location)
	const workspace = path.isAbsolute(def.workspace)
		? def.workspace
		: path.resolve(path.dirname(resolvedPath), def.workspace);

	// Ensure workspace exists
	const { mkdirSync } = require("node:fs");
	mkdirSync(workspace, { recursive: true });

	// 6. Initialize state tracker
	const stateTracker = new StateTracker(workspace, def.name);
	stateTracker.init([...def.agents.keys()], def.targetCount, def.mode);

	// 7. Log start
	const agentList = [...def.agents.keys()].join(", ");
	const waveDesc = waves.map((w, i) => `wave ${i + 1}: [${w.join(", ")}]`).join("; ");
	pi.logger.debug?.("Swarm starting", {
		name: def.name,
		mode: def.mode,
		agents: agentList,
		waves: waveDesc,
		workspace,
	});

	ctx.ui.notify(
		`Starting swarm '${def.name}': ${def.agents.size} agents, ${waves.length} waves, ${def.targetCount} iteration(s)`,
		"info",
	);

	// 8. Set up progress widget
	const widgetKey = `swarm-${def.name}`;
	const updateWidget = () => {
		const lines = renderSwarmProgress(stateTracker.state);
		ctx.ui.setWidget?.(widgetKey, lines);
	};
	updateWidget();

	// 9. Run pipeline
	const controller = new PipelineController(def, waves, stateTracker);

	const result = await controller.run({
		workspace,
		callerUrl: import.meta.url,
		onProgress: () => updateWidget(),
	});

	// 10. Clear widget and show summary
	ctx.ui.setWidget?.(widgetKey, undefined);

	const elapsed = stateTracker.state.completedAt
		? formatDuration(stateTracker.state.completedAt - stateTracker.state.startedAt)
		: "unknown";

	const summaryParts = [
		`Swarm '${def.name}' ${result.status}`,
		`${result.iterations}/${def.targetCount} iterations`,
		`elapsed: ${elapsed}`,
	];

	if (result.errors.length > 0) {
		summaryParts.push(`${result.errors.length} error(s)`);
	}

	const summaryType = result.status === "completed" ? "info" : "error";
	ctx.ui.notify(summaryParts.join(" | "), summaryType);

	// Log errors
	if (result.errors.length > 0) {
		pi.logger.warn?.("Swarm completed with errors", { errors: result.errors });
	}

	// 11. Send summary to the conversation so the LLM knows what happened
	const summaryMessage = buildSummaryMessage(def, result, stateTracker, workspace);
	(pi as any).sendMessage?.(
		{
			type: "swarm-result",
			text: summaryMessage,
		},
		{ triggerTurn: false },
	);
}

// ============================================================================
// /swarm status
// ============================================================================

async function handleStatus(
	name: string | undefined,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!name) {
		ctx.ui.notify(
			"Usage: /swarm status <name>  (reads .swarm_<name>/state/pipeline.json from cwd)",
			"info",
		);
		return;
	}

	const stateTracker = new StateTracker(ctx.cwd, name);
	const state = stateTracker.load();
	if (!state) {
		ctx.ui.notify(`No state found for swarm '${name}' in ${ctx.cwd}`, "error");
		return;
	}

	const lines = renderSwarmProgress(state);
	ctx.ui.notify(lines.join("\n"), "info");
}

// ============================================================================
// Helpers
// ============================================================================

function formatDuration(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	const m = Math.floor(totalSec / 60);
	const s = totalSec % 60;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

function buildSummaryMessage(
	def: SwarmDefinition,
	result: { status: string; iterations: number; errors: string[] },
	stateTracker: StateTracker,
	workspace: string,
): string {
	const lines: string[] = [];
	lines.push(`## Swarm Pipeline: ${def.name}`);
	lines.push("");
	lines.push(`- **Status**: ${result.status}`);
	lines.push(`- **Mode**: ${def.mode}`);
	lines.push(`- **Iterations**: ${result.iterations}/${def.targetCount}`);
	lines.push(`- **Workspace**: ${workspace}`);
	lines.push(`- **State dir**: ${stateTracker.swarmDir}`);
	lines.push("");

	lines.push("### Agent Results");
	lines.push("");
	for (const [name, agent] of Object.entries(stateTracker.state.agents)) {
		const duration =
			agent.startedAt && agent.completedAt
				? formatDuration(agent.completedAt - agent.startedAt)
				: "n/a";
		lines.push(
			`- **${name}**: ${agent.status} (${duration})${agent.error ? ` — ${agent.error}` : ""}`,
		);
	}

	if (result.errors.length > 0) {
		lines.push("");
		lines.push("### Errors");
		lines.push("");
		for (const error of result.errors) {
			lines.push(`- ${error}`);
		}
	}

	return lines.join("\n");
}
