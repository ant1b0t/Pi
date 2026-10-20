import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildCompletionEnvelope,
	getCompletionFilePath,
	readCompletionEnvelope,
	type CompletionLikeState,
} from "../extensions/base/agent-completion.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeState(sessionFile: string, overrides: Partial<CompletionLikeState> = {}): CompletionLikeState {
	return {
		id: 1,
		name: "test-agent",
		runSeq: 1,
		status: "error",
		lastAssistantText: "",
		currentStreamText: "",
		lastErrorMessage: "",
		turnCount: 0,
		toolCount: 0,
		elapsed: 999_999,
		startTime: Date.now() - 25,
		sessionFile,
		killed: true,
		timedOut: false,
		...overrides,
	};
}

function makeSessionFile(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "agent-completion-test-"));
	tempDirs.push(dir);
	return path.join(dir, "session.jsonl");
}

describe("agent completion", () => {
	it("stores interrupted stream as partial text, never as final text", () => {
		const sessionFile = makeSessionFile();
		writeFileSync(sessionFile, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "old run answer" }] } })}\n`);

		const envelope = buildCompletionEnvelope(makeState(sessionFile, {
			currentStreamText: "unfinished current stream",
		}), null);

		expect(envelope.outcome).toBe("interrupted");
		expect(envelope.finalText).toBe("");
		expect(envelope.partialText).toBe("unfinished current stream");
		expect(envelope.elapsedMs).toBeLessThan(999_999);
	});

	it("uses completed checkpoint text when interrupted without an active stream", () => {
		const envelope = buildCompletionEnvelope(makeState(makeSessionFile(), {
			currentStreamText: "",
			lastAssistantText: "completed checkpoint",
		}), null);

		expect(envelope.outcome).toBe("interrupted");
		expect(envelope.finalText).toBe("");
		expect(envelope.partialText).toBe("completed checkpoint");
	});

	it("keeps successful terminal session text as final output", () => {
		const sessionFile = makeSessionFile();
		writeFileSync(sessionFile, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "successful answer" }] } })}\n`);

		const envelope = buildCompletionEnvelope(makeState(sessionFile, {
			status: "done",
			killed: false,
			lastAssistantText: "",
		}), 0);

		expect(envelope.outcome).toBe("success");
		expect(envelope.finalText).toBe("successful answer");
		expect(envelope.partialText).toBeUndefined();
	});

	it("does not reuse session text for a tool-only continuation", () => {
		const sessionFile = makeSessionFile();
		writeFileSync(sessionFile, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "OLD CHECKPOINT" }] } }) + "\n");
		const result = buildCompletionEnvelope(makeState(sessionFile, {
			runSeq: 2, status: "done", killed: false, toolCount: 1,
		}), 0);
		expect(result.finalText).toBe("");
		expect(result.outcome).toBe("tool-only");
	});

	it("uses a continuation's new answer instead of old session contents", () => {
		const sessionFile = makeSessionFile();
		writeFileSync(sessionFile, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "OLD CHECKPOINT" }] } }) + "\n");
		const result = buildCompletionEnvelope(makeState(sessionFile, {
			runSeq: 2, status: "done", killed: false, lastAssistantText: "new final answer", toolCount: 1,
		}), 0);
		expect(result.outcome).toBe("success");
		expect(result.finalText).toBe("new final answer");
	});

	it("initial-run session fallback remains final text even with observed tool calls", () => {
		const sessionFile = makeSessionFile();
		writeFileSync(sessionFile, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "new final answer" }] } }) + "\n");
		const result = buildCompletionEnvelope(makeState(sessionFile, {
			status: "done", killed: false, toolCount: 1,
		}), 0);
		expect(result.outcome).toBe("success");
		expect(result.finalText).toBe("new final answer");
	});

	it("persists interruption reason, budget and last observed activity", () => {
		const result = buildCompletionEnvelope(makeState(makeSessionFile(), {
			timedOut: true, interruptionReason: "runtime_budget", runtimeBudgetMs: 400,
			lastActivityAt: 123456,
		}), null);
		expect(result.interruptionReason).toBe("runtime_budget");
		expect(result.runtimeBudgetMs).toBe(400);
		expect(result.lastActivityAt).toBe(123456);
		expect(result.finalText).toBe("");
	});

	it("requires the requested run completion and allows base-file reads without a run", () => {
		const sessionFile = makeSessionFile();
		const baseFile = getCompletionFilePath(sessionFile);
		writeFileSync(baseFile, JSON.stringify({ version: 1, runSeq: 1, finalText: "previous run" }));

		expect(readCompletionEnvelope(sessionFile, 2)).toBeUndefined();
		expect(readCompletionEnvelope(sessionFile)?.finalText).toBe("previous run");

		const runTwoFile = getCompletionFilePath(sessionFile, 2);
		writeFileSync(runTwoFile, JSON.stringify({ version: 1, runSeq: 1, finalText: "wrong sequence" }));
		expect(readCompletionEnvelope(sessionFile, 2)).toBeUndefined();
	});
});
