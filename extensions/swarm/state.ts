// ============================================================================
// Filesystem state tracker — адаптировано из oh-my-pi/packages/swarm-extension
//
// Persists pipeline and per-agent state to `.swarm_<name>/` in the workspace.
// Supports resumability by loading state from disk.
// ============================================================================

import { mkdirSync, existsSync, appendFileSync, writeFileSync, readFileSync } from "node:fs";
import * as path from "node:path";

// ============================================================================
// State types
// ============================================================================

export type PipelineStatus = "idle" | "running" | "completed" | "failed" | "aborted";
export type AgentStatus = "pending" | "waiting" | "running" | "completed" | "failed";

export interface AgentState {
	name: string;
	status: AgentStatus;
	iteration: number;
	wave: number;
	startedAt?: number;
	completedAt?: number;
	error?: string;
}

export interface SwarmState {
	name: string;
	status: PipelineStatus;
	mode: string;
	iteration: number;
	targetCount: number;
	agents: Record<string, AgentState>;
	startedAt: number;
	completedAt?: number;
}

// ============================================================================
// State tracker
// ============================================================================

export class StateTracker {
	#swarmDir: string;
	#state: SwarmState;

	constructor(workspaceDir: string, name: string) {
		this.#swarmDir = path.join(workspaceDir, `.swarm_${name}`);
		this.#state = {
			name,
			status: "idle",
			mode: "sequential",
			iteration: 0,
			targetCount: 1,
			agents: {},
			startedAt: Date.now(),
		};
	}

	get swarmDir(): string {
		return this.#swarmDir;
	}

	get state(): Readonly<SwarmState> {
		return this.#state;
	}

	init(agentNames: string[], targetCount: number, mode: string): void {
		mkdirSync(path.join(this.#swarmDir, "state"), { recursive: true });
		mkdirSync(path.join(this.#swarmDir, "logs"), { recursive: true });
		mkdirSync(path.join(this.#swarmDir, "context"), { recursive: true });

		this.#state.targetCount = targetCount;
		this.#state.mode = mode;
		this.#state.status = "running";
		this.#state.startedAt = Date.now();

		for (const name of agentNames) {
			this.#state.agents[name] = {
				name,
				status: "pending",
				iteration: 0,
				wave: 0,
			};
		}

		this.#persist();
	}

	updateAgent(name: string, update: Partial<AgentState>): void {
		const agent = this.#state.agents[name];
		if (!agent) return;
		Object.assign(agent, update);
		this.#persist();
	}

	updatePipeline(update: Partial<SwarmState>): void {
		Object.assign(this.#state, update);
		this.#persist();
	}

	appendLog(agentName: string, message: string): void {
		const logPath = path.join(this.#swarmDir, "logs", `${agentName}.log`);
		const timestamp = new Date().toISOString();
		appendFileSync(logPath, `[${timestamp}] ${message}\n`);
	}

	appendOrchestratorLog(message: string): void {
		const logPath = path.join(this.#swarmDir, "logs", "orchestrator.log");
		const timestamp = new Date().toISOString();
		appendFileSync(logPath, `[${timestamp}] ${message}\n`);
	}

	load(): SwarmState | null {
		const statePath = path.join(this.#swarmDir, "state", "pipeline.json");
		try {
			if (!existsSync(statePath)) return null;
			this.#state = JSON.parse(readFileSync(statePath, "utf-8")) as SwarmState;
			return this.#state;
		} catch {
			return null;
		}
	}

	#persist(): void {
		writeFileSync(
			path.join(this.#swarmDir, "state", "pipeline.json"),
			JSON.stringify(this.#state, null, 2),
		);
	}
}
