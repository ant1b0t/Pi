// ============================================================================
// Pipeline controller — адаптировано из oh-my-pi/packages/swarm-extension
//
// Orchestrates execution waves within each iteration:
// - Agents in the same wave execute in parallel
// - Waves execute sequentially (wave N+1 starts after wave N completes)
// - For pipeline mode, iterations repeat the full DAG execution
// ============================================================================

import { executeSwarmAgent, type SwarmAgentResult, type SwarmExecutorOptions } from "./executor";
import type { SwarmDefinition } from "./schema";
import type { StateTracker } from "./state";

// ============================================================================
// Types
// ============================================================================

export interface PipelineOptions {
	workspace: string;
	callerUrl: string;
	signal?: AbortSignal;
	onProgress?: (state: PipelineProgress) => void;
}

export interface PipelineProgress {
	iteration: number;
	targetCount: number;
	currentWave: number;
	totalWaves: number;
	agents: Record<string, { status: string; iteration: number }>;
}

export interface PipelineResult {
	status: "completed" | "failed" | "aborted";
	iterations: number;
	agentResults: Map<string, SwarmAgentResult[]>;
	errors: string[];
}

// ============================================================================
// Controller
// ============================================================================

export class PipelineController {
	#def: SwarmDefinition;
	#waves: string[][];
	#stateTracker: StateTracker;

	constructor(def: SwarmDefinition, waves: string[][], stateTracker: StateTracker) {
		this.#def = def;
		this.#waves = waves;
		this.#stateTracker = stateTracker;
	}

	async run(options: PipelineOptions): Promise<PipelineResult> {
		const { workspace, callerUrl, signal, onProgress } = options;
		const allResults = new Map<string, SwarmAgentResult[]>();
		const errors: string[] = [];

		for (const name of this.#def.agents.keys()) {
			allResults.set(name, []);
		}

		const targetCount = this.#def.targetCount;

		this.#stateTracker.appendOrchestratorLog(
			`Pipeline '${this.#def.name}' starting: mode=${this.#def.mode} iterations=${targetCount} waves=${this.#waves.length} agents=${this.#def.agents.size}`,
		);

		try {
			for (let iteration = 0; iteration < targetCount; iteration++) {
				if (signal?.aborted) {
					this.#stateTracker.updatePipeline({ status: "aborted" });
					return { status: "aborted", iterations: iteration, agentResults: allResults, errors };
				}

				this.#stateTracker.updatePipeline({ iteration });
				this.#stateTracker.appendOrchestratorLog(`--- Iteration ${iteration + 1}/${targetCount} ---`);

				const emitProgress = (currentWave: number) => {
					onProgress?.({
						iteration,
						targetCount,
						currentWave,
						totalWaves: this.#waves.length,
						agents: this.#buildProgressSnapshot(),
					});
				};

				const iterationResults = await this.#runIteration(iteration, {
					workspace,
					callerUrl,
					signal,
					emitProgress,
				});

				for (const [agentName, result] of iterationResults) {
					allResults.get(agentName)!.push(result);
					if (result.status !== "completed") {
						errors.push(
							`${agentName} (iteration ${iteration + 1}): ${result.error || `exit code ${result.exitCode}`}`,
						);
					}
				}
			}

			const status = errors.length > 0 ? "failed" : "completed";
			this.#stateTracker.updatePipeline({ status, completedAt: Date.now() });
			this.#stateTracker.appendOrchestratorLog(`Pipeline ${status} (${errors.length} errors)`);
			return { status, iterations: targetCount, agentResults: allResults, errors };
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			this.#stateTracker.updatePipeline({ status: "failed", completedAt: Date.now() });
			this.#stateTracker.appendOrchestratorLog(`Pipeline fatal error: ${error}`);
			errors.push(error);
			return { status: "failed", iterations: 0, agentResults: allResults, errors };
		}
	}

	async #runIteration(
		iteration: number,
		options: {
			workspace: string;
			callerUrl: string;
			signal?: AbortSignal;
			emitProgress: (currentWave: number) => void;
		},
	): Promise<Map<string, SwarmAgentResult>> {
		const results = new Map<string, SwarmAgentResult>();
		let agentIndex = 0;

		for (let waveIdx = 0; waveIdx < this.#waves.length; waveIdx++) {
			const wave = this.#waves[waveIdx];

			if (options.signal?.aborted) break;

			this.#stateTracker.appendOrchestratorLog(
				`Wave ${waveIdx + 1}/${this.#waves.length}: [${wave.join(", ")}]`,
			);

			// Mark agents in this wave as waiting
			for (const agentName of wave) {
				this.#stateTracker.updateAgent(agentName, {
					status: "waiting",
					iteration,
					wave: waveIdx,
				});
			}
			options.emitProgress(waveIdx);

			// Execute all agents in wave in parallel
			const waveResults = await Promise.all(
				wave.map(async (agentName) => {
					const agent = this.#def.agents.get(agentName)!;
					const currentIndex = agentIndex++;
					try {
						return await executeSwarmAgent(agent, currentIndex, {
							workspace: options.workspace,
							swarmName: this.#def.name,
							iteration,
							modelOverride: agent.model ?? this.#def.model,
							signal: options.signal,
							stateTracker: this.#stateTracker,
							callerUrl: options.callerUrl,
						});
					} catch (err) {
						return {
							agentName,
							status: "failed" as const,
							exitCode: 1,
							output: "",
							stderr: err instanceof Error ? err.message : String(err),
							error: err instanceof Error ? err.message : String(err),
							durationMs: 0,
							modelUsed: "unknown",
						};
					}
				}),
			);

			for (const result of waveResults) {
				results.set(result.agentName, result);
			}

			options.emitProgress(waveIdx);
		}

		return results;
	}

	#buildProgressSnapshot(): Record<string, { status: string; iteration: number }> {
		const snapshot: Record<string, { status: string; iteration: number }> = {};
		for (const [name, agent] of Object.entries(this.#stateTracker.state.agents)) {
			snapshot[name] = { status: agent.status, iteration: agent.iteration };
		}
		return snapshot;
	}
}
