export type AgentWorkPhase = "research" | "implementation" | "verification";

export function normalizePhase(value?: string): AgentWorkPhase | undefined {
	if (value === "research" || value === "implementation" || value === "verification") return value;
	return undefined;
}

export function buildPhaseGuidance(phase?: AgentWorkPhase): string {
	if (!phase) return "";
	if (phase === "research") {
		return [
			"## Phase: research",
			"Your job is to investigate and return findings, not to implement changes unless explicitly requested.",
			"Focus on evidence, relevant files, options, constraints, and recommended next steps.",
		].join("\n");
	}
	if (phase === "implementation") {
		return [
			"## Phase: implementation",
			"Your job is to make or describe the concrete change requested.",
			"Prefer explicit edits, touched files, and concise rationale. Call out anything that still needs verification.",
		].join("\n");
	}
	return [
		"## Phase: verification",
		"Your job is to validate prior work, review diffs/results, and identify risks or follow-up checks.",
		"Prefer verification evidence, failing gaps, and a clear pass/fail style conclusion.",
	].join("\n");
}

export function validatePhaseTransition(from?: AgentWorkPhase, to?: AgentWorkPhase): { ok: boolean; warnings: string[] } {
	if (!from || !to || from === to) return { ok: true, warnings: [] };
	const validTransitions: Record<AgentWorkPhase, AgentWorkPhase[]> = {
		research: ["implementation", "verification"],
		implementation: ["verification", "research"],
		verification: ["implementation", "research"],
	};
	if (validTransitions[from].includes(to)) return { ok: true, warnings: [] };
	return {
		ok: true,
		warnings: [`Phase transition "${from}" → "${to}" is unusual. Typical flow: research → implementation → verification.`],
	};
}
