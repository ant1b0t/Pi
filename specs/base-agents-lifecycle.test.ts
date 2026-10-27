import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import * as actualRunner from "../extensions/base/agent-runner.ts?lifecycle-test-original";
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

class FakeChild extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	pid = 4242;
	kills: string[] = [];
	kill(signal = "SIGTERM"): boolean {
		this.kills.push(signal);
		return true;
	}
	close(code: number | null = 0): void {
		this.emit("close", code, null);
	}
	writeEvent(event: unknown): void {
		this.stdout.write(`${JSON.stringify(event)}\n`);
	}
}

const children: FakeChild[] = [];
let nextSpawnError: Error | undefined;
const spawnOptions: Array<Record<string, any>> = [];
const runnerPath = new URL("../extensions/base/agent-runner.ts", import.meta.url).pathname;
const tuiPath = "@mariozechner/pi-tui";
const typeboxPath = "@sinclair/typebox";
const schema = (kind: string, options: any = {}) => ({ kind, ...options });

mock.module(tuiPath, () => ({
	Editor: class {},
	Text: class {},
	Key: { escape: "escape", up: "up", down: "down", enter: "enter" },
	matchesKey: () => false,
	truncateToWidth: (text: string) => text,
}));
mock.module(typeboxPath, () => ({
	Type: {
		String: (options?: any) => schema("string", options),
		Number: (options?: any) => schema("number", options),
		Integer: (options?: any) => schema("integer", options),
		Boolean: (options?: any) => schema("boolean", options),
		Array: (items: any, options?: any) => schema("array", { items, ...options }),
		Object: (properties: any, options?: any) => schema("object", { properties, ...options }),
		Optional: (value: any) => ({ ...value, optional: true }),
	},
}));
const runnerMock = () => ({
	...actualRunner,
	killProcess(proc: ChildProcess) { proc.kill("SIGTERM"); },
	spawnPiProcess(options: Record<string, any>) {
		if (nextSpawnError) { const error = nextSpawnError; nextSpawnError = undefined; throw error; }
		spawnOptions.push(options);
		const child = new FakeChild();
		children.push(child);
		return child as unknown as ChildProcess;
	},
});
mock.module(runnerPath, runnerMock);
mock.module("../extensions/base/agent-runner.ts", runnerMock);

const { default: baseAgents } = await import("../extensions/base/base-agents.ts");
const NOTIFICATION_DELAY_MS = 2500;
const MAX_TIMER_MS = 2_147_483_647;

type Tool = { execute: (...args: any[]) => Promise<any> };
type Fixture = ReturnType<typeof makeFixture>;
let fixture: Fixture;

function makeFixture() {
	const cwd = mkdtempSync(path.join(tmpdir(), "base-agents-lifecycle-"));
	const tools = new Map<string, Tool>();
	const commands = new Map<string, any>();
	const hooks = new Map<string, Function[]>();
	const sentMessages: any[] = [];
	const notifications: any[] = [];
	const widgets = new Map<string, unknown>();
	const pi = {
		registerTool(definition: any) { tools.set(definition.name, definition); },
		registerCommand(name: string, definition: any) { commands.set(name, definition); },
		on(name: string, handler: Function) {
			const list = hooks.get(name) ?? [];
			list.push(handler);
			hooks.set(name, list);
		},
		sendMessage(message: any) { sentMessages.push(message); },
	};
	const ctx = {
		cwd,
		hasUI: true,
		model: { provider: "fake", id: "model" },
		ui: {
			notify(message: string, level: string) { notifications.push({ message, level }); },
			setWidget(key: string, widget: unknown) {
				if (widget === undefined) widgets.delete(key);
				else widgets.set(key, widget);
			},
			async custom() { return undefined; },
		},
	};
	const listenerEvents = ["exit", "beforeExit", "SIGINT", "SIGTERM"] as const;
	const oldAllowedTools = process.env.PI_AGENT_ALLOWED_TOOLS;
	delete process.env.PI_AGENT_ALLOWED_TOOLS;
	const priorListeners = new Map(listenerEvents.map((event) => [event, new Set(process.listeners(event))]));
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	const timeoutHandles = new Set<ReturnType<typeof setTimeout>>();
	const timeoutDelays: number[] = [];
	const scheduledTimers: Array<{ handle: ReturnType<typeof setTimeout>; delay: number; callback: TimerHandler; args: any[] }> = [];
	globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: any[]) => {
		const ms = Number(delay ?? 0);
		timeoutDelays.push(ms);
		let handle: ReturnType<typeof setTimeout>;
		handle = realSetTimeout((...callbackArgs: any[]) => {
			timeoutHandles.delete(handle);
			const index = scheduledTimers.findIndex((item) => item.handle === handle);
			if (index >= 0) scheduledTimers.splice(index, 1);
			if (typeof callback === "function") callback(...callbackArgs);
		}, ms, ...args);
		timeoutHandles.add(handle);
		scheduledTimers.push({ handle, delay: ms, callback, args });
		return handle;
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
		if (handle) {
			timeoutHandles.delete(handle);
			const index = scheduledTimers.findIndex((item) => item.handle === handle);
			if (index >= 0) scheduledTimers.splice(index, 1);
		}
		realClearTimeout(handle);
	}) as typeof clearTimeout;

	baseAgents(pi as any);
	const tool = (name: string) => {
		const found = tools.get(name);
		if (!found) throw new Error(`Tool not registered: ${name}`);
		return found;
	};
	const call = (name: string, params: any, signal?: AbortSignal) => tool(name).execute("test-call", params, signal, () => {}, ctx);
	const spawn = (params: Record<string, any> = {}) => call("agent_spawn", {
		task: "Analyze this lifecycle behavior carefully",
		...params,
	});
	let shutDown = false;
	const shutdown = async () => {
		if (shutDown) return;
		shutDown = true;
		for (const handler of hooks.get("session_shutdown") ?? []) await handler({}, ctx);
	};
	const captureTimeout = (delay: number) => {
		const timer = scheduledTimers.find((item) => item.delay === delay);
		if (!timer || typeof timer.callback !== "function") throw new Error(`No pending callback to capture (delay ${delay})`);
		return () => timer.callback(...timer.args);
	};
	const fireTimeout = (delay: number) => {
		const index = scheduledTimers.findIndex((item) => item.delay === delay);
		if (index < 0) throw new Error(`No pending timeout to fire (delay ${delay})`);
		const [{ handle, callback, args }] = scheduledTimers.splice(index, 1);
		realClearTimeout(handle);
		timeoutHandles.delete(handle);
		if (typeof callback === "function") callback(...args);
	};
	return { cwd, tools, commands, hooks, sentMessages, notifications, widgets, ctx, call, spawn, shutdown, timeoutDelays, timeoutHandles, captureTimeout, fireTimeout, realSetTimeout, realClearTimeout, priorListeners, oldAllowedTools };
}

beforeEach(() => {
	nextSpawnError = undefined;
	children.length = 0;
	spawnOptions.length = 0;
	fixture = makeFixture();
});

afterEach(async () => {
	try {
		await fixture.shutdown();
	} finally {
		for (const child of children) {
			child.stdout.destroy();
			child.stderr.destroy();
		}
		for (const handle of fixture.timeoutHandles) fixture.realClearTimeout(handle);
		globalThis.setTimeout = fixture.realSetTimeout;
		globalThis.clearTimeout = fixture.realClearTimeout;
		if (fixture.oldAllowedTools === undefined) delete process.env.PI_AGENT_ALLOWED_TOOLS;
		else process.env.PI_AGENT_ALLOWED_TOOLS = fixture.oldAllowedTools;
		for (const event of ["exit", "beforeExit", "SIGINT", "SIGTERM"] as const) {
			for (const listener of process.listeners(event)) {
				if (!fixture.priorListeners.get(event)?.has(listener)) process.removeListener(event, listener);
			}
		}
		rmSync(fixture.cwd, { recursive: true, force: true });
	}
});

function emitAnswer(child: FakeChild, text: string): void {
	child.writeEvent({
		type: "agent_end",
		messages: [{ role: "assistant", content: [{ type: "text", text }] }],
	});
}

function sessionDir(): string {
	return path.join(fixture.cwd, ".pi", "agent-sessions", "subagents");
}

async function loadTierFixture(tiers: unknown): Promise<void> {
	mkdirSync(path.join(fixture.cwd, ".pi"), { recursive: true });
	writeFileSync(path.join(fixture.cwd, ".pi", "model-tiers.json"), JSON.stringify(tiers));
	for (const handler of fixture.hooks.get("session_start") ?? []) await handler({}, fixture.ctx);
}

describe("base-agents model effort", () => {
	it("passes the selected effort to the child and preserves the pair on all continuations", async () => {
		await loadTierFixture({
			high: "fake/high",
			medium: { model: "fake/shared", effort: "xhigh" },
			low: [{ model: "fake/shared", effort: "off" }, { model: "fake/shared", effort: "max" }],
		});
		await fixture.spawn({ tier: "low" });
		const selected = spawnOptions[0];
		expect(selected.model).toBe("fake/shared");
		expect(["off", "max"]).toContain(selected.thinkingLevel);
		children[0].close(0);
		await fixture.call("agent_continue", { id: 1, prompt: "Continue the selected task" });
		expect(spawnOptions[1].model).toBe(selected.model);
		expect(spawnOptions[1].thinkingLevel).toBe(selected.thinkingLevel);
		children[1].close(0);
		await fixture.commands.get("acont").handler("1 Continue through command", fixture.ctx);
		expect(spawnOptions[2].thinkingLevel).toBe(selected.thinkingLevel);
		await fixture.spawn({ tier: "low" });
		expect(spawnOptions[3].thinkingLevel).not.toBe(selected.thinkingLevel);
		children[2].close(0);
		await fixture.call("agent_continue", { id: 1, tier: "medium", prompt: "Change the selected tier" });
		expect(spawnOptions[4].model).toBe("fake/shared");
		expect(spawnOptions[4].thinkingLevel).toBe("xhigh");
		children[4].close(0);
		await fixture.call("agent_continue", { id: 1, model: "fake/unknown", prompt: "Change the selected model" });
		expect(spawnOptions[5].model).toBe("fake/unknown");
		expect(spawnOptions[5].thinkingLevel).toBe("off");
	});

	it("uses explicit model effort within the requested tier but never infers parent effort", async () => {
		await loadTierFixture({
			high: { model: "fake/model", effort: "max" },
			medium: { model: "fake/shared", effort: "xhigh" },
			low: { model: "fake/shared", effort: "low" },
		});
		await fixture.spawn();
		expect(spawnOptions[0].model).toBe("fake/model");
		expect(spawnOptions[0].thinkingLevel).toBe("off");
		await fixture.spawn({ model: "fake/shared", tier: "low" });
		expect(spawnOptions[1].thinkingLevel).toBe("low");
		await fixture.spawn({ model: "fake/shared" });
		expect(spawnOptions[2].thinkingLevel).toBe("xhigh");
	});
});

describe("base-agents lifecycle regression", () => {
	it("tool-only recovery never returns an older report, even without a completion sidecar", async () => {
		await fixture.spawn({ runtimeBudgetMs: 40 });
		const session = spawnOptions[0].sessionFile;
		writeFileSync(session, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "OLD CHECKPOINT" }] } }) + "\n");
		emitAnswer(children[0], "OLD CHECKPOINT");
		fixture.fireTimeout(40); children[0].close(1);
		await fixture.call("agent_continue", { id: 1, prompt: "Continue carefully", runtimeBudgetMs: 0 });
		children[1].writeEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "true" } }] } });
		children[1].close(0);
		const joined = await fixture.call("agent_join", { id: 1 });
		expect(joined.details.completionOutcome).toBe("tool-only");
		expect(joined.content[0].text).not.toContain("OLD CHECKPOINT");
		unlinkSync(session.replace(/\.jsonl$/, ".run-2.completion.json"));
		const fallback = await fixture.call("agent_result", { id: 1 });
		expect(fallback.content[0].text).not.toContain("OLD CHECKPOINT");
		expect(fallback.content[0].text).toMatch(/no text|no final/i);
	});

	it("persists distinct stop reasons and does not replace activity time with close time", async () => {
		const clock = spyOn(Date, "now").mockReturnValue(10000);
		try {
			await fixture.spawn({ runtimeBudgetMs: 40 });
			clock.mockReturnValue(10010);
			emitAnswer(children[0], "checkpoint");
			clock.mockReturnValue(10040); fixture.fireTimeout(40);
			clock.mockReturnValue(10050); children[0].close(1);
			const result = await fixture.call("agent_result", { id: 1 });
			const envelope = JSON.parse(readFileSync(result.details.completionFile, "utf8"));
			expect(envelope.interruptionReason).toBe("runtime_budget");
			expect(envelope.runtimeBudgetMs).toBe(40);
			expect(envelope.lastActivityAt).toBe(10010);
			expect(envelope.elapsedMs).toBe(50);
			await fixture.spawn();
			await fixture.commands.get("akill").handler("2", fixture.ctx);
			const killed = JSON.parse(readFileSync(spawnOptions[1].sessionFile.replace(/\.jsonl$/, ".completion.json"), "utf8"));
			expect(killed.interruptionReason).toBe("user_kill");
			await fixture.spawn();
			await fixture.shutdown();
			const shutdown = JSON.parse(readFileSync(spawnOptions[2].sessionFile.replace(/\.jsonl$/, ".completion.json"), "utf8"));
			expect(shutdown.interruptionReason).toBe("parent_shutdown");
		} finally { clock.mockRestore(); }
	});

	it("startup errors notify once and respect ui/turn/off modes", async () => {
		await fixture.spawn({ notify: "turn" });
		children[0].emit("error", new Error("spawn ENOENT"));
		children[0].close(-1);
		expect(fixture.notifications.filter((item) => item.level === "error")).toHaveLength(1);
		fixture.fireTimeout(NOTIFICATION_DELAY_MS);
		expect(fixture.sentMessages).toHaveLength(1);
		expect(fixture.sentMessages[0].content).toContain("error");
		await fixture.spawn({ notify: "ui" });
		children[1].emit("error", new Error("spawn failed"));
		expect(fixture.notifications.filter((item) => item.level === "error")).toHaveLength(2);
		expect(fixture.sentMessages).toHaveLength(1);
		await fixture.spawn({ notify: "off" });
		children[2].emit("error", new Error("silent failure"));
		expect(fixture.notifications.filter((item) => item.level === "error")).toHaveLength(2);
		expect(() => fixture.captureTimeout(NOTIFICATION_DELAY_MS)).toThrow();
	});

	it("synchronous startup failure wakes parent and joining suppresses delayed notification", async () => {
		nextSpawnError = new Error("Cannot resolve Pi CLI");
		await fixture.spawn({ notify: "turn" });
		expect(fixture.notifications.at(-1).level).toBe("error");
		const joined = await fixture.call("agent_join", { id: 1 });
		expect(joined.isError).toBe(true);
		expect(joined.content[0].text).toContain("Cannot resolve Pi CLI");
		expect(() => fixture.captureTimeout(NOTIFICATION_DELAY_MS)).toThrow();
	});

	it("aclear hides finished widgets without losing results, IDs, notifications or continuation", async () => {
		await fixture.spawn({ notify: "turn" });
		await fixture.spawn({ name: "working" });
		const session = spawnOptions[0].sessionFile;
		emitAnswer(children[0], "result still available");
		children[0].close(0);
		await fixture.commands.get("aclear").handler("", fixture.ctx);
		expect(fixture.widgets.has("agent-1")).toBe(false);
		expect(fixture.widgets.has("agent-2")).toBe(true);
		expect(existsSync(session)).toBe(true);
		const listed = await fixture.call("agent_list", {});
		expect(listed.content[0].text).toContain("#1 [agent-1] DONE");
		expect(listed.content[0].text).toContain("#2 [working] RUNNING");
		fixture.fireTimeout(NOTIFICATION_DELAY_MS);
		expect(fixture.sentMessages).toHaveLength(1);
		expect((await fixture.call("agent_result", { id: 1 })).content[0].text).toContain("result still available");
		expect((await fixture.call("agent_join", { id: 1 })).content[0].text).toContain("result still available");
		await fixture.spawn({ name: "new-worker" }); // Forces widget refresh, without revealing hidden rows.
		expect(fixture.widgets.has("agent-1")).toBe(false);
		expect(fixture.widgets.has("agent-3")).toBe(true);
		await fixture.call("agent_continue", { id: 1, prompt: "Continue with the next bounded task" });
		expect(fixture.widgets.has("agent-1")).toBe(true);
		expect(spawnOptions[3].sessionFile).toBe(session);
		expect(spawnOptions[3].isContinuation).toBe(true);
	});

	it("aclear preserves failed diagnostics and does not bypass successful shutdown cleanup", async () => {
		await fixture.spawn();
		await fixture.spawn({ name: "failed" });
		const successSession = spawnOptions[0].sessionFile;
		const failedSession = spawnOptions[1].sessionFile;
		emitAnswer(children[0], "done");
		children[0].close(0);
		children[1].close(1);
		await fixture.commands.get("aclear").handler("", fixture.ctx);
		await fixture.commands.get("aclear").handler("", fixture.ctx);
		expect(fixture.widgets.size).toBe(0);
		expect((await fixture.call("agent_result", { id: 2 })).isError).toBe(true);
		expect((await fixture.call("agent_list", {})).content[0].text).toContain("#2 [failed] ERROR");
		await fixture.shutdown();
		expect(existsSync(successSession)).toBe(false);
		expect(existsSync(failedSession)).toBe(true);
	});

	it("join timeout returns while running without killing; a later join gets result", async () => {
		await fixture.spawn();
		const waiting = fixture.call("agent_join", { id: 1, timeoutMs: 10 });
		fixture.fireTimeout(10);
		const result = await waiting;
		expect(result.isError).not.toBe(true);
		expect((await fixture.call("agent_list", {})).content[0].text).toContain("RUNNING");
		expect(children[0].kills).toEqual([]);

		emitAnswer(children[0], "completed answer");
		children[0].close(0);
		const joined = await fixture.call("agent_join", { id: 1, timeoutMs: 100 });
		expect(joined.isError).not.toBe(true);
		expect(joined.content[0].text).toContain("completed answer");
	});

	it("agent_wait_any timeout returns without killing a running child", async () => {
		await fixture.spawn();
		const waiting = fixture.call("agent_wait_any", { ids: [1], timeoutMs: 12 });
		fixture.fireTimeout(12);
		const result = await waiting;
		expect(result.content[0].text.toLowerCase()).toContain("timed out");
		expect((await fixture.call("agent_list", {})).content[0].text).toContain("RUNNING");
		expect(children[0].kills).toEqual([]);
	});

	it("default spawn has no 20-minute process watchdog", async () => {
		await fixture.spawn();
		expect(fixture.timeoutDelays).not.toContain(20 * 60 * 1000);
		expect(children[0].kills).toEqual([]);
	});

	it("positive runtime budget kills process and blocks continuation until close", async () => {
		await fixture.spawn({ runtimeBudgetMs: 40 });
		fixture.fireTimeout(40);
		expect(children[0].kills).toContain("SIGTERM");
		const early = await fixture.call("agent_continue", { id: 1, prompt: "Continue after timeout" });
		expect(early.isError).toBe(true);
		expect(children).toHaveLength(1);

		children[0].close(1);
		const resumed = await fixture.call("agent_continue", { id: 1, prompt: "Continue after timeout" });
		expect(resumed.isError).not.toBe(true);
		expect(children).toHaveLength(2);
	});

	it("runtime timeout reports interrupted partial output; continuation reuses session as run 2", async () => {
		await fixture.spawn({ runtimeBudgetMs: 40 });
		const sessionFile = spawnOptions[0].sessionFile;
		emitAnswer(children[0], "partial answer before timeout");
		fixture.fireTimeout(40);
		children[0].close(1);
		const interrupted = await fixture.call("agent_join", { id: 1, timeoutMs: 100 });
		expect(interrupted.isError).toBe(true);
		expect(interrupted.details.completionOutcome).toBe("interrupted");
		expect(interrupted.content[0].text.toLowerCase()).toContain("partial output");
		expect(interrupted.content[0].text).toContain("partial answer before timeout");

		await fixture.call("agent_continue", { id: 1, prompt: "Continue the analysis" });
		expect(spawnOptions[1].sessionFile).toBe(sessionFile);
		expect(spawnOptions[1].isContinuation).toBe(true);
		emitAnswer(children[1], "resumed answer");
		children[1].close(0);
		const joined = await fixture.call("agent_join", { id: 1, timeoutMs: 100 });
		expect(joined.details.runSeq).toBe(2);
		expect(joined.content[0].text).toContain("resumed answer");
	});

	it("/acont advances run sequence and continues the same session", async () => {
		await fixture.spawn();
		const sessionFile = spawnOptions[0].sessionFile;
		emitAnswer(children[0], "first run");
		children[0].close(0);
		await fixture.commands.get("acont").handler("1 Continue with a second pass", fixture.ctx);
		expect(spawnOptions[1].sessionFile).toBe(sessionFile);
		expect(spawnOptions[1].isContinuation).toBe(true);
		emitAnswer(children[1], "second run");
		children[1].close(0);
		const result = await fixture.call("agent_result", { id: 1 });
		expect(result.details.runSeq).toBe(2);
		expect(result.content[0].text).toContain("second run");
	});

	it("inherits per-run budget and explicit zero disables watchdog", async () => {
		await fixture.spawn({ runtimeBudgetMs: 90 });
		expect(fixture.timeoutDelays).toContain(90);
		children[0].close(0);
		const beforeInherited = fixture.timeoutDelays.length;
		await fixture.call("agent_continue", { id: 1, prompt: "Continue without changing budget" });
		expect(fixture.timeoutDelays.slice(beforeInherited)).toContain(90);
		children[1].close(0);
		const beforeCleared = fixture.timeoutDelays.length;
		await fixture.call("agent_continue", { id: 1, prompt: "Continue without a budget", runtimeBudgetMs: 0 });
		expect(fixture.timeoutDelays.slice(beforeCleared)).not.toContain(90);
		expect(fixture.timeoutDelays.slice(beforeCleared)).not.toContain(20 * 60 * 1000);
	});

	it("rejects invalid runtime and wait timeout values", async () => {
		for (const runtimeBudgetMs of [-1, 1.5, MAX_TIMER_MS + 1, Number.NaN, Number.POSITIVE_INFINITY, "50"]) {
			const result = await fixture.spawn({ runtimeBudgetMs });
			expect(result.isError).toBe(true);
		}
		expect(children).toHaveLength(0);

		await fixture.spawn();
		for (const timeoutMs of [0, -1, 1.5, MAX_TIMER_MS + 1, Number.NaN, Number.POSITIVE_INFINITY, "50"]) {
			const joined = await fixture.call("agent_join", { id: 1, timeoutMs });
			expect(joined.isError).toBe(true);
			const waited = await fixture.call("agent_wait_any", { ids: [1], timeoutMs });
			expect(waited.isError).toBe(true);
		}
		expect(children[0].kills).toEqual([]);
	});

	it("stale child callbacks cannot change a resumed run", async () => {
		await fixture.spawn();
		const oldChild = children[0];
		oldChild.close(0);
		await fixture.call("agent_continue", { id: 1, prompt: "Start a new run" });
		oldChild.writeEvent({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "stale output" }] }] });
		oldChild.close(1);
		const running = await fixture.call("agent_list", {});
		expect(running.content[0].text).toContain("#1 [agent-1] RUNNING");
		expect(children).toHaveLength(2);

		emitAnswer(children[1], "current output");
		children[1].close(0);
		const result = await fixture.call("agent_join", { id: 1, timeoutMs: 100 });
		expect(result.content[0].text).toContain("current output");
		expect(result.content[0].text).not.toContain("stale output");
	});

	it("already-aborted wait signals return promptly and leave no stale waiter", async () => {
		await fixture.spawn();
		const controller = new AbortController();
		controller.abort();
		const result = await fixture.call("agent_join", { id: 1, timeoutMs: 1000 }, controller.signal);
		expect(result.isError).toBe(true);
		expect(result.content[0].text.toLowerCase()).toContain("cancel");
		expect(children[0].kills).toEqual([]);
		emitAnswer(children[0], "join after cancellation");
		children[0].close(0);
		const joined = await fixture.call("agent_join", { id: 1, timeoutMs: 100 });
		expect(joined.content[0].text).toContain("join after cancellation");
	});

	it("shutdown deletes owned successful session files, retains failures and other files", async () => {
		await fixture.spawn({ name: "success" });
		await fixture.spawn({ name: "failure" });
		await fixture.spawn({ name: "timeout", runtimeBudgetMs: 40 });
		const successSession = spawnOptions[0].sessionFile;
		const failedSession = spawnOptions[1].sessionFile;
		const timeoutSession = spawnOptions[2].sessionFile;
		emitAnswer(children[0], "done");
		children[0].close(0);
		children[1].close(1);
		fixture.fireTimeout(40);
		children[2].close(1);
		const unrelated = path.join(sessionDir(), "unrelated-session.jsonl");
		writeFileSync(unrelated, "keep me");
		const successSidecar = path.join(sessionDir(), `${path.basename(successSession, ".jsonl")}.completion.json`);
		const failureSidecar = path.join(sessionDir(), `${path.basename(failedSession, ".jsonl")}.completion.json`);
		const timeoutSidecar = path.join(sessionDir(), `${path.basename(timeoutSession, ".jsonl")}.completion.json`);
		expect(existsSync(successSidecar)).toBe(true);
		expect(existsSync(failureSidecar)).toBe(true);
		expect(existsSync(timeoutSidecar)).toBe(true);

		await fixture.shutdown();
		expect(existsSync(successSession)).toBe(false);
		expect(existsSync(successSidecar)).toBe(false);
		expect(existsSync(failedSession)).toBe(true);
		expect(existsSync(failureSidecar)).toBe(true);
		expect(existsSync(timeoutSession)).toBe(true);
		expect(existsSync(timeoutSidecar)).toBe(true);
		expect(existsSync(unrelated)).toBe(true);
	});

	it("turn notification still sends delayed follow-up when requested", async () => {
		await fixture.spawn({ notify: "turn" });
		emitAnswer(children[0], "notification result");
		children[0].close(0);
		expect(fixture.sentMessages).toHaveLength(0);
		fixture.fireTimeout(NOTIFICATION_DELAY_MS);
		expect(fixture.sentMessages).toHaveLength(1);
		expect(fixture.sentMessages[0].customType).toBe("agent-notification");
	});

	it("session recreation clears runtime deadlines and preserves interrupted diagnostics", async () => {
		await fixture.spawn({ runtimeBudgetMs: 123456 });
		const session = spawnOptions[0].sessionFile;
		for (const handler of fixture.hooks.get("session_start") ?? []) await handler({}, fixture.ctx);
		expect(children[0].kills).toContain("SIGTERM");
		expect(() => fixture.captureTimeout(123456)).toThrow();
		expect(JSON.parse(readFileSync(session.replace(/\.jsonl$/, ".completion.json"), "utf8")).outcome).toBe("interrupted");
	});

	it("shutdown cancels a pending turn notification", async () => {
		await fixture.spawn({ notify: "turn" });
		emitAnswer(children[0], "done before shutdown");
		children[0].close(0);
		const pendingNotification = fixture.captureTimeout(NOTIFICATION_DELAY_MS);
		await fixture.shutdown();
		pendingNotification();
		expect(fixture.sentMessages).toHaveLength(0);
	});

	it("prior interrupted result remains readable while continuation runs", async () => {
		await fixture.spawn({ runtimeBudgetMs: 30 });
		emitAnswer(children[0], "saved checkpoint");
		fixture.fireTimeout(30);
		children[0].close(1);
		await fixture.call("agent_continue", { id: 1, prompt: "Inspect changes before continuing", runtimeBudgetMs: 0 });
		const prior = await fixture.call("agent_result", { id: 1, runSeq: 1 });
		expect(prior.details.runSeq).toBe(1);
		expect(prior.details.outcome).toBe("interrupted");
		expect(prior.content[0].text).toContain("saved checkpoint");
		expect(prior.details.completionFile).toBe(spawnOptions[0].sessionFile.replace(/\.jsonl$/, ".completion.json"));
		expect(children[1].kills).toEqual([]);
	});

	it("wait_all timeout preserves completed and running agents for a later join", async () => {
		await fixture.spawn({ name: "done" });
		await fixture.spawn({ name: "working" });
		emitAnswer(children[0], "first result");
		children[0].close(0);

		const waiting = fixture.call("agent_wait_all", { ids: [1, 2], timeoutMs: 15 });
		fixture.fireTimeout(15);
		const timedOut = await waiting;
		expect(timedOut.details.status).toBe("timeout");
		expect(timedOut.details.runningIds).toEqual([2]);
		expect(children.map((child) => child.kills)).toEqual([[], []]);
		expect((await fixture.call("agent_list", {})).content[0].text).toContain("#1 [done] DONE");
		expect((await fixture.call("agent_list", {})).content[0].text).toContain("#2 [working] RUNNING");

		emitAnswer(children[1], "second result");
		children[1].close(0);
		const joined = await fixture.call("agent_wait_all", { ids: [1, 2], join: true });
		expect(joined.content[0].text).toContain("first result");
		expect(joined.content[0].text).toContain("second result");
	});

	it("wait bound to run 1 never returns run 2 output after synchronous continuation", async () => {
		await fixture.spawn();
		const waiting = fixture.call("agent_wait_any", { ids: [1] });
		emitAnswer(children[0], "run one answer");
		children[0].close(0);
		const continuing = fixture.call("agent_continue", { id: 1, prompt: "Start run two" });
		await continuing;
		emitAnswer(children[1], "run two answer");
		children[1].close(0);

		const result = await waiting;
		if (result.details?.status === "stale_run") {
			expect(result.isError).toBe(true);
		} else {
			expect(result.details?.runSeq).toBe(1);
			expect(result.content[0].text).toContain("run one answer");
		}
		expect(result.content[0].text).not.toContain("run two answer");
	});

	it("stale runtime timer and process error cannot affect a resumed run", async () => {
		await fixture.spawn({ runtimeBudgetMs: 40 });
		const oldChild = children[0];
		const staleTimeout = fixture.captureTimeout(40);
		oldChild.close(0);
		await fixture.call("agent_continue", { id: 1, prompt: "Start a clean run" });

		staleTimeout();
		oldChild.emit("error", new Error("stale process error"));
		expect(oldChild.kills).toEqual([]);
		expect(children[1].kills).toEqual([]);
		expect((await fixture.call("agent_list", {})).content[0].text).toContain("#1 [agent-1] RUNNING");

		emitAnswer(children[1], "clean result");
		children[1].close(0);
		const joined = await fixture.call("agent_join", { id: 1, timeoutMs: 100 });
		expect(joined.content[0].text).toContain("clean result");
		expect(joined.content[0].text).not.toContain("stale process error");
	});

	it("shutdown preserves failed and timed-out run diagnostics, cleans successful continuation history", async () => {
		await fixture.spawn({ name: "failed" });
		await fixture.spawn({ name: "timed-out", runtimeBudgetMs: 25 });
		await fixture.spawn({ name: "successful-only" });
		const failedSession = spawnOptions[0].sessionFile;
		const timedOutSession = spawnOptions[1].sessionFile;
		const successSession = spawnOptions[2].sessionFile;
		children[0].close(1);
		fixture.fireTimeout(25);
		children[1].close(1);
		emitAnswer(children[2], "first success");
		children[2].close(0);

		await fixture.call("agent_continue", { id: 1, prompt: "Recover failed run" });
		await fixture.call("agent_continue", { id: 2, prompt: "Recover timeout" });
		await fixture.call("agent_continue", { id: 3, prompt: "Second successful pass" });
		emitAnswer(children[3], "recovered failure");
		children[3].close(0);
		emitAnswer(children[4], "recovered timeout");
		children[4].close(0);
		emitAnswer(children[5], "second success");
		children[5].close(0);

		const sidecar = (session: string, run: number) => path.join(sessionDir(), `${path.basename(session, ".jsonl")}${run > 1 ? `.run-${run}` : ""}.completion.json`);
		await fixture.shutdown();
		for (const [session, outcome] of [[failedSession, "error"], [timedOutSession, "interrupted"]] as const) {
			expect(existsSync(session)).toBe(true);
			expect(existsSync(sidecar(session, 1))).toBe(true);
			expect(JSON.parse(readFileSync(sidecar(session, 1), "utf8")).outcome).toBe(outcome);
			expect(existsSync(sidecar(session, 2))).toBe(true);
		}
		expect(existsSync(successSession)).toBe(false);
		expect(existsSync(sidecar(successSession, 1))).toBe(false);
		expect(existsSync(sidecar(successSession, 2))).toBe(false);
	});

	it("shutdown persists interruption for running child and preserves unrelated session", async () => {
		await fixture.spawn();
		const session = spawnOptions[0].sessionFile;
		const unrelated = path.join(sessionDir(), "other-runtime-session.jsonl");
		writeFileSync(unrelated, "keep external session");

		await fixture.shutdown();
		expect(children[0].kills).toContain("SIGTERM");
		expect(existsSync(session)).toBe(true);
		const completion = path.join(sessionDir(), `${path.basename(session, ".jsonl")}.completion.json`);
		expect(existsSync(completion)).toBe(true);
		expect(JSON.parse(readFileSync(completion, "utf8")).outcome).toBe("interrupted");
		expect(readFileSync(unrelated, "utf8")).toBe("keep external session");
	});

	it("runtime timeout notifies as error and missing historical result never falls back to current run", async () => {
		await fixture.spawn({ notify: "turn", runtimeBudgetMs: 30 });
		fixture.fireTimeout(30);
		children[0].close(1);
		expect(fixture.notifications.at(-1).level).toBe("error");
		fixture.fireTimeout(NOTIFICATION_DELAY_MS);
		expect(fixture.sentMessages).toHaveLength(1);

		await fixture.spawn();
		const session = spawnOptions[1].sessionFile;
		emitAnswer(children[1], "historical run");
		children[1].close(0);
		await fixture.call("agent_continue", { id: 2, prompt: "Current run" });
		emitAnswer(children[2], "current run only");
		children[2].close(0);
		unlinkSync(path.join(sessionDir(), `${path.basename(session, ".jsonl")}.completion.json`));
		const missing = await fixture.call("agent_result", { id: 2, runSeq: 1 });
		expect(missing.isError).toBe(true);
		expect(missing.content[0].text).not.toContain("current run only");
	});
});
