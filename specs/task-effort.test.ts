import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

mock.module("@mariozechner/pi-tui", () => ({
	Editor: class {},
	Text: class {},
	Key: { escape: "escape", up: "up", down: "down", enter: "enter" },
	matchesKey: () => false,
	truncateToWidth: (text: string) => text,
}));
const schema = (_value?: unknown) => ({});
mock.module("@sinclair/typebox", () => ({
	Type: { String: schema, Number: schema, Integer: schema, Boolean: schema, Array: schema, Object: schema, Optional: schema },
}));
const { default: baseTools } = await import("../extensions/base/base-tools.ts");

let cwd: string;
let previousCli: string | undefined;
let previousAllowlist: string | undefined;
let task: any;
beforeEach(() => {
	cwd = mkdtempSync(path.join(tmpdir(), "task-effort-"));
	mkdirSync(path.join(cwd, ".pi"));
	writeFileSync(path.join(cwd, ".pi", "model-tiers.json"), JSON.stringify({
		high: { model: "fake/parent", effort: "max" },
		medium: "fake/medium",
		low: [{ model: "fake/one", effort: "off" }, { model: "fake/two", effort: "minimal" }],
	}));
	const cli = path.join(cwd, "fake-cli.cjs");
	writeFileSync(cli, `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(process.argv.slice(2)) }] } }));`);
	previousCli = process.env.PI_CLI_PATH;
	previousAllowlist = process.env.PI_AGENT_ALLOWED_TOOLS;
	process.env.PI_CLI_PATH = cli;
	delete process.env.PI_AGENT_ALLOWED_TOOLS;
	baseTools({
		registerTool(def: any) { if (def.name === "task") task = def; },
		registerCommand() {},
		on() {},
	} as any);
});
afterEach(() => {
	if (previousCli === undefined) delete process.env.PI_CLI_PATH;
	else process.env.PI_CLI_PATH = previousCli;
	if (previousAllowlist === undefined) delete process.env.PI_AGENT_ALLOWED_TOOLS;
	else process.env.PI_AGENT_ALLOWED_TOOLS = previousAllowlist;
	rmSync(cwd, { recursive: true, force: true });
});

async function run(params: unknown): Promise<string[][]> {
	const result = await task.execute("test", params, undefined, undefined, { cwd, model: { provider: "fake", id: "parent" } });
	expect(result.isError).not.toBe(true);
	return result.details.workerResults.map((worker: any) => JSON.parse(worker.outputText));
}

it("task fan-out sends each round-robin model with its own effort", async () => {
	const runs = await run({ tasks: ["First task", "Second task"], tier: "low" });
	const pairs = runs.map(args => [args[args.indexOf("--model") + 1], args[args.indexOf("--thinking") + 1]]);
	expect(pairs).toContainEqual(["fake/one", "off"]);
	expect(pairs).toContainEqual(["fake/two", "minimal"]);
});

it("task inherits parent model with thinking off, not the parent's configured tier effort", async () => {
	const [args] = await run({ description: "Inherit parent model" });
	expect(args[args.indexOf("--model") + 1]).toBe("fake/parent");
	expect(args[args.indexOf("--thinking") + 1]).toBe("off");
});
