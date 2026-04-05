import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { extractTerminalResultFromFile } from "./agent-events.ts";

export type AgentCompletionOutcome = "success" | "error" | "tool-only" | "interrupted";

export interface AgentCompletionEnvelope {
	version: 1;
	agentId: number;
	agentName: string;
	runSeq: number;
	finishedAt: string;
	elapsedMs: number;
	exitCode: number | null;
	status: "done" | "error";
	outcome: AgentCompletionOutcome;
	finalText: string;
	lastError: string | null;
	turnCount: number;
	toolCount: number;
	lastTool: { name: string; args: string } | null;
	sessionFile: string;
}

export interface CompletionLikeState {
	id: number;
	name: string;
	runSeq: number;
	status: "running" | "done" | "error";
	lastAssistantText: string;
	lastErrorMessage: string;
	turnCount: number;
	toolCount: number;
	elapsed: number;
	startTime: number;
	sessionFile: string;
	killed: boolean;
	timedOut: boolean;
	lastTool?: { name: string; args: string };
}

export function getCompletionFilePath(sessionFile: string, runSeq?: number): string {
	const dir = path.dirname(sessionFile);
	const base = path.basename(sessionFile, path.extname(sessionFile));
	return path.join(dir, runSeq && runSeq > 1
		? `${base}.run-${runSeq}.completion.json`
		: `${base}.completion.json`);
}

export function buildCompletionEnvelope(state: CompletionLikeState, exitCode: number | null): AgentCompletionEnvelope {
	const terminal = extractTerminalResultFromFile(state.sessionFile);
	let outcome: AgentCompletionOutcome = "success";
	let finalText = state.lastAssistantText || "";
	let lastError = state.lastErrorMessage || null;

	if (state.killed || state.timedOut) {
		outcome = "interrupted";
	} else if (terminal.kind === "error" || state.status === "error") {
		outcome = "error";
		lastError = terminal.error || state.lastErrorMessage || null;
	} else if (terminal.kind === "tool-only") {
		outcome = "tool-only";
	} else {
		outcome = "success";
	}

	if (!finalText) {
		if (terminal.kind === "text") finalText = terminal.text || "";
		else if (terminal.kind === "error") finalText = "";
		else if (terminal.kind === "tool-only") finalText = "";
	}

	return {
		version: 1,
		agentId: state.id,
		agentName: state.name,
		runSeq: state.runSeq,
		finishedAt: new Date().toISOString(),
		elapsedMs: state.elapsed || Math.max(0, Date.now() - state.startTime),
		exitCode,
		status: state.status === "running" ? (exitCode === 0 && !state.killed ? "done" : "error") : state.status,
		outcome,
		finalText,
		lastError,
		turnCount: state.turnCount,
		toolCount: state.toolCount,
		lastTool: state.lastTool ? { ...state.lastTool } : null,
		sessionFile: state.sessionFile,
	};
}

export function persistCompletionEnvelope(state: CompletionLikeState, exitCode: number | null): string | undefined {
	const completionFile = getCompletionFilePath(state.sessionFile, state.runSeq);
	try {
		mkdirSync(path.dirname(completionFile), { recursive: true });
		const envelope = buildCompletionEnvelope(state, exitCode);
		writeFileSync(completionFile, JSON.stringify(envelope, null, 2), "utf-8");
		return completionFile;
	} catch {
		return undefined;
	}
}

export function readCompletionEnvelope(sessionFile: string, runSeq?: number): AgentCompletionEnvelope | undefined {
	const candidates = [
		getCompletionFilePath(sessionFile, runSeq),
		getCompletionFilePath(sessionFile),
	];
	for (const file of candidates) {
		if (!existsSync(file)) continue;
		try {
			const parsed = JSON.parse(readFileSync(file, "utf-8"));
			if (parsed && parsed.version === 1) return parsed as AgentCompletionEnvelope;
		} catch {
			// fall through to next candidate/current logic
		}
	}
	return undefined;
}
