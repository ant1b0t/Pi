/**
 * Base Agents — Unit Tests
 *
 * Run: bun test specs/base-agents.unit.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Import modules under test ────────────────────────────────────────────

import {
	resolveTagsToTools,
	toolsNeedBaseTools,
	toolsNeedBaseAgents,
	getBuiltinTools,
	BASE_TOOLS,
	TAG_TOOLS,
} from "../extensions/base/agent-tags.ts";

import {
	parseAgentEvent,
	extractTerminalResult,
	extractTerminalResultFromFile,
	parseSessionFile,
	getTextFromContent,
	getElapsedTime,
	extractLastAssistantText,
	extractMessageContent,
} from "../extensions/base/agent-events.ts";

import {
	loadModelTiers,
	resolveModel,
	reverseLookupTier,
	currentModelString,
	modelLabel,
} from "../extensions/base/model-tiers.ts";

import {
	canonicalizeToolList,
	resolveToolsParam,
	makeSessionFile,
	cleanSessionDir,
	AGENT_JOIN_TIMEOUT_MS,
	AGENT_JOIN_POLL_INTERVAL_MS,
} from "../extensions/base/agent-runner.ts";

// ── agent-tags.ts Tests ─────────────────────────────────────────────────

describe("agent-tags.ts", () => {
	describe("resolveTagsToTools()", () => {
		it("returns BASE_TOOLS for empty string", () => {
			const result = resolveTagsToTools("");
			expect(result).toEqual([...BASE_TOOLS].sort());
		});

		it("adds bash and script_run for Bash tag", () => {
			const result = resolveTagsToTools("Bash");
			expect(result).toContain("bash");
			expect(result).toContain("script_run");
		});

		it("adds web_fetch for Web tag", () => {
			const result = resolveTagsToTools("Web");
			expect(result).toContain("web_fetch");
		});

		it("adds edit, write, apply_patch for FS tag", () => {
			const result = resolveTagsToTools("FS");
			expect(result).toContain("edit");
			expect(result).toContain("write");
			expect(result).toContain("apply_patch");
		});

		it("adds agent tools for Agents tag", () => {
			const result = resolveTagsToTools("Agents");
			expect(result).toContain("agent_spawn");
			expect(result).toContain("agent_join");
			expect(result).toContain("agent_continue");
			expect(result).toContain("agent_list");
		});

		it("combines multiple tags", () => {
			const result = resolveTagsToTools("Wr,Web,Bash");
			expect(result).toContain("edit");
			expect(result).toContain("web_fetch");
			expect(result).toContain("bash");
		});

		it("trims whitespace from tags", () => {
			const result1 = resolveTagsToTools("  Bash  ");
			const result2 = resolveTagsToTools("Bash");
			expect(result1).toEqual(result2);
		});

		it("ignores unknown tags", () => {
			const result = resolveTagsToTools("Bash,UnknownTag");
			expect(result).toContain("bash");
			expect(result).not.toContain("UnknownTag");
		});

		it("always includes BASE_TOOLS", () => {
			const result = resolveTagsToTools("Web");
			for (const tool of BASE_TOOLS) {
				expect(result).toContain(tool);
			}
		});

		it("returns sorted, unique tools", () => {
			const result = resolveTagsToTools("Bash,Bash,Web");
			const unique = [...new Set(result)];
			expect(result).toEqual(unique.sort());
		});
	});

	describe("toolsNeedBaseTools()", () => {
		it("returns true for web_fetch", () => {
			expect(toolsNeedBaseTools(["web_fetch"])).toBe(true);
		});

		it("returns true for todo", () => {
			expect(toolsNeedBaseTools(["todo"])).toBe(true);
		});

		it("returns true for ask_user", () => {
			expect(toolsNeedBaseTools(["ask_user"])).toBe(true);
		});

		it("returns true for glob", () => {
			expect(toolsNeedBaseTools(["glob"])).toBe(true);
		});

		it("returns false for builtin tools only", () => {
			expect(toolsNeedBaseTools(["read", "bash", "grep"])).toBe(false);
		});

		it("returns true if any tool needs base-tools", () => {
			expect(toolsNeedBaseTools(["read", "web_fetch"])).toBe(true);
		});
	});

	describe("toolsNeedBaseAgents()", () => {
		it("returns true for agent_spawn", () => {
			expect(toolsNeedBaseAgents(["agent_spawn"])).toBe(true);
		});

		it("returns true for agent_join", () => {
			expect(toolsNeedBaseAgents(["agent_join"])).toBe(true);
		});

		it("returns true for agent_continue", () => {
			expect(toolsNeedBaseAgents(["agent_continue"])).toBe(true);
		});

		it("returns true for agent_list", () => {
			expect(toolsNeedBaseAgents(["agent_list"])).toBe(true);
		});

		it("returns false for other tools", () => {
			expect(toolsNeedBaseAgents(["read", "bash", "web_fetch"])).toBe(false);
		});
	});

	describe("getBuiltinTools()", () => {
		it("filters only builtin tools", () => {
			const result = getBuiltinTools(["read", "web_fetch", "agent_spawn", "bash"]);
			expect(result).toContain("read");
			expect(result).toContain("bash");
			expect(result).not.toContain("web_fetch");
			expect(result).not.toContain("agent_spawn");
		});

		it("returns empty array for no builtins", () => {
			const result = getBuiltinTools(["web_fetch", "agent_spawn"]);
			expect(result).toEqual([]);
		});
	});
});

// ── agent-events.ts Tests ────────────────────────────────────────────────

describe("agent-events.ts", () => {
	describe("parseAgentEvent()", () => {
		let state: any;

		beforeEach(() => {
			state = {
				turnCount: 0,
				toolCount: 0,
				lastAssistantText: "",
				lastErrorMessage: "",
				currentStreamText: "",
			};
		});

		it("handles message_update with text_delta", () => {
			parseAgentEvent({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "Hello " },
			}, state);
			parseAgentEvent({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "world" },
			}, state);
			expect(state.currentStreamText).toBe("Hello world");
		});

		it("handles message_end and finalizes text", () => {
			state.currentStreamText = "streamed text";
			parseAgentEvent({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "message text" }],
				},
			}, state);
			expect(state.turnCount).toBe(1);
			expect(state.lastAssistantText).toBe("streamed text");
			expect(state.currentStreamText).toBe("");
		});

		it("uses content text when no stream", () => {
			parseAgentEvent({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "fallback text" }],
				},
			}, state);
			expect(state.lastAssistantText).toBe("fallback text");
		});

		it("captures error message", () => {
			parseAgentEvent({
				type: "message_end",
				message: {
					role: "assistant",
					content: [],
					errorMessage: "API error",
				},
			}, state);
			expect(state.lastErrorMessage).toBe("API error");
		});

		it("counts tool calls", () => {
			parseAgentEvent({
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", name: "read", arguments: {} },
						{ type: "toolCall", name: "bash", arguments: {} },
					],
				},
			}, state);
			expect(state.toolCount).toBe(2);
		});

		it("handles tool_execution_start", () => {
			parseAgentEvent({
				type: "tool_execution_start",
				toolName: "read",
				args: { path: "/test" },
			}, state);
			expect(state.lastTool).toEqual({ name: "read", args: '{"path":"/test"}' });
		});

		it("handles agent_end with text result", () => {
			parseAgentEvent({
				type: "agent_end",
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "final answer" }] },
				],
			}, state);
			expect(state.lastAssistantText).toBe("final answer");
		});

		it("handles agent_end with error result", () => {
			parseAgentEvent({
				type: "agent_end",
				messages: [
					{ role: "assistant", content: [], errorMessage: "something went wrong" },
				],
			}, state);
			expect(state.lastErrorMessage).toBe("something went wrong");
		});
	});

	describe("extractTerminalResult()", () => {
		it("returns text kind for assistant text", () => {
			const result = extractTerminalResult([
				{ role: "assistant", content: [{ type: "text", text: "answer" }] },
			]);
			expect(result.kind).toBe("text");
			expect(result.text).toBe("answer");
		});

		it("returns error kind for error message", () => {
			const result = extractTerminalResult([
				{ role: "assistant", content: [], errorMessage: "API error" },
			]);
			expect(result.kind).toBe("error");
			expect(result.error).toBe("API error");
		});

		it("returns tool-only kind for tool results without text", () => {
			const result = extractTerminalResult([
				{ role: "toolResult", toolName: "read", content: "file content" },
				{ role: "assistant", content: [{ type: "toolCall", name: "read" }] },
			]);
			expect(result.kind).toBe("tool-only");
		});

		it("returns empty kind for empty messages", () => {
			const result = extractTerminalResult([]);
			expect(result.kind).toBe("empty");
		});

		it("hasToolResults true when tool results present", () => {
			const result = extractTerminalResult([
				{ role: "assistant", content: [{ type: "text", text: "answer" }] },
				{ role: "toolResult", toolName: "read", content: "data" },
			]);
			expect(result.hasToolResults).toBe(true);
		});
	});

	describe("getTextFromContent()", () => {
		it("extracts text from content array", () => {
			const result = getTextFromContent([
				{ type: "text", text: "Hello " },
				{ type: "toolCall", name: "read" },
				{ type: "text", text: "world" },
			]);
			expect(result).toBe("Hello world");
		});

		it("returns empty for empty array", () => {
			expect(getTextFromContent([])).toBe("");
		});

		it("returns empty for non-array", () => {
			expect(getTextFromContent(null)).toBe("");
			expect(getTextFromContent("string")).toBe("");
		});
	});

	describe("getElapsedTime()", () => {
		it("formats seconds only", () => {
			const start = new Date("2024-01-01T00:00:00");
			const end = new Date("2024-01-01T00:00:45");
			expect(getElapsedTime(start, end)).toBe("45s");
		});

		it("formats minutes and seconds", () => {
			const start = new Date("2024-01-01T00:00:00");
			const end = new Date("2024-01-01T00:03:25");
			expect(getElapsedTime(start, end)).toBe("3m 25s");
		});
	});

	describe("extractLastAssistantText()", () => {
		it("extracts last assistant text", () => {
			const messages = [
				{ role: "user", content: [{ type: "text", text: "hi" }] },
				{ role: "assistant", content: [{ type: "text", text: "hello" }] },
				{ role: "assistant", content: [{ type: "text", text: "world" }] },
			];
			expect(extractLastAssistantText(messages)).toBe("world");
		});

		it("returns empty if no assistant messages", () => {
			const messages = [
				{ role: "user", content: [{ type: "text", text: "hi" }] },
			];
			expect(extractLastAssistantText(messages)).toBe("");
		});
	});
});

// ── model-tiers.ts Tests ─────────────────────────────────────────────────

describe("model-tiers.ts", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-${Date.now()}`);
		mkdirSync(join(tempDir, ".pi"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	describe("loadModelTiers()", () => {
		it("loads valid model-tiers.json", () => {
			const tiers = {
				high: "anthropic/claude-opus",
				medium: "anthropic/claude-sonnet",
				low: "anthropic/claude-haiku",
			};
			writeFileSync(
				join(tempDir, ".pi", "model-tiers.json"),
				JSON.stringify(tiers)
			);

			const result = loadModelTiers(tempDir);
			expect(result).toEqual(tiers);
		});

		it("returns null for missing file", () => {
			const result = loadModelTiers(tempDir);
			expect(result).toBeNull();
		});

		it("returns null for invalid JSON", () => {
			writeFileSync(
				join(tempDir, ".pi", "model-tiers.json"),
				"not valid json"
			);
			const result = loadModelTiers(tempDir);
			expect(result).toBeNull();
		});

		it("returns null for missing required fields", () => {
			writeFileSync(
				join(tempDir, ".pi", "model-tiers.json"),
				JSON.stringify({ high: "model" }) // missing medium, low
			);
			const result = loadModelTiers(tempDir);
			expect(result).toBeNull();
		});

		it("accepts arrays for tiers", () => {
			const tiers = {
				high: ["model1", "model2"],
				medium: "model3",
				low: "model4",
			};
			writeFileSync(
				join(tempDir, ".pi", "model-tiers.json"),
				JSON.stringify(tiers)
			);
			const result = loadModelTiers(tempDir);
			expect(result).toEqual(tiers);
		});
	});

	describe("resolveModel()", () => {
		const tiers = {
			high: "high-model",
			medium: "medium-model",
			low: "low-model",
		};

		it("returns explicit model when provided", () => {
			const result = resolveModel({ model: "custom-model", tiers });
			expect(result).toBe("custom-model");
		});

		it("resolves high tier", () => {
			const result = resolveModel({ tier: "high", tiers });
			expect(result).toBe("high-model");
		});

		it("resolves medium tier", () => {
			const result = resolveModel({ tier: "medium", tiers });
			expect(result).toBe("medium-model");
		});

		it("resolves low tier", () => {
			const result = resolveModel({ tier: "low", tiers });
			expect(result).toBe("low-model");
		});

		it("uses fallback when tier not found", () => {
			const result = resolveModel({ tier: "unknown", tiers: null, fallback: "fallback-model" });
			expect(result).toBe("fallback-model");
		});

		it("round-robins array tiers", () => {
			const arrayTiers = {
				high: ["model1", "model2"],
				medium: "medium-model",
				low: "low-model",
			};
			const r1 = resolveModel({ tier: "high", tiers: arrayTiers });
			const r2 = resolveModel({ tier: "high", tiers: arrayTiers });
			const r3 = resolveModel({ tier: "high", tiers: arrayTiers });
			expect(r1).toBe("model1");
			expect(r2).toBe("model2");
			expect(r3).toBe("model1"); // cycles back
		});

		it("returns undefined when nothing matches", () => {
			const result = resolveModel({});
			expect(result).toBeUndefined();
		});
	});

	describe("reverseLookupTier()", () => {
		const tiers = {
			high: "high-model",
			medium: ["medium-1", "medium-2"],
			low: "low-model",
		};

		it("finds tier by exact match", () => {
			expect(reverseLookupTier("high-model", tiers)).toBe("high");
		});

		it("finds tier in array", () => {
			expect(reverseLookupTier("medium-1", tiers)).toBe("medium");
			expect(reverseLookupTier("medium-2", tiers)).toBe("medium");
		});

		it("returns undefined for unknown model", () => {
			expect(reverseLookupTier("unknown", tiers)).toBeUndefined();
		});

		it("returns undefined for null tiers", () => {
			expect(reverseLookupTier("model", null)).toBeUndefined();
		});
	});

	describe("currentModelString()", () => {
		it("returns provider/id format", () => {
			const result = currentModelString({ provider: "openai", id: "gpt-4" });
			expect(result).toBe("openai/gpt-4");
		});

		it("returns id only when no provider", () => {
			const result = currentModelString({ id: "gpt-4" });
			expect(result).toBe("gpt-4");
		});

		it("handles name field", () => {
			const result = currentModelString({ provider: "openai", name: "gpt-4" });
			expect(result).toBe("openai/gpt-4");
		});

		it("trims whitespace", () => {
			const result = currentModelString({ provider: "  openai  ", id: "  gpt-4  " });
			expect(result).toBe("openai/gpt-4");
		});

		it("skips empty provider", () => {
			const result = currentModelString({ provider: "", id: "gpt-4" });
			expect(result).toBe("gpt-4");
		});

		it("returns undefined for null", () => {
			expect(currentModelString(null)).toBeUndefined();
		});

		it("returns undefined for empty object", () => {
			expect(currentModelString({})).toBeUndefined();
		});
	});

	describe("modelLabel()", () => {
		it("extracts last segment", () => {
			expect(modelLabel("anthropic/claude-sonnet")).toBe("claude-sonnet");
		});

		it("returns as-is for no slash", () => {
			expect(modelLabel("gpt-4")).toBe("gpt-4");
		});

		it("returns default for empty", () => {
			expect(modelLabel("")).toBe("default");
		});

		it("returns default for undefined", () => {
			expect(modelLabel(undefined)).toBe("default");
		});
	});
});

// ── agent-runner.ts Tests ────────────────────────────────────────────────

describe("agent-runner.ts", () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		originalCwd = process.cwd();
		process.chdir(tempDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	describe("canonicalizeToolList()", () => {
		it("sorts tools alphabetically", () => {
			const result = canonicalizeToolList(["zebra", "apple", "banana"]);
			expect(result).toEqual(["apple", "banana", "zebra"]);
		});

		it("removes duplicates", () => {
			const result = canonicalizeToolList(["read", "read", "bash"]);
			expect(result).toEqual(["bash", "read"]);
		});

		it("trims whitespace", () => {
			const result = canonicalizeToolList(["  read  ", "  bash  "]);
			expect(result).toEqual(["bash", "read"]);
		});

		it("filters empty strings", () => {
			const result = canonicalizeToolList(["read", "", "bash", ""]);
			expect(result).toEqual(["bash", "read"]);
		});
	});

	describe("resolveToolsParam()", () => {
		it("returns default tools for undefined", () => {
			const result = resolveToolsParam(undefined);
			expect(result).toContain("bash");
			expect(result).toContain("script_run");
		});

		it("resolves tag string", () => {
			const result = resolveToolsParam("Web,Bash");
			expect(result).toContain("web_fetch");
			expect(result).toContain("bash");
		});

		it("resolves array of tools", () => {
			const result = resolveToolsParam(["read", "bash", "read"]); // duplicate
			expect(result).toEqual(canonicalizeToolList(["bash", "read"]));
		});
	});

	describe("makeSessionFile()", () => {
		it("creates session file with correct name", () => {
			const result = makeSessionFile(123, tempDir, "test-agents");
			expect(result).toContain("agent-123-");
			expect(result).toContain(".jsonl");
			expect(existsSync(result)).toBe(true);
		});

		it("creates parent directories", () => {
			const result = makeSessionFile(1, tempDir, "nested/path");
			expect(existsSync(join(tempDir, ".pi", "agent-sessions", "nested", "path"))).toBe(true);
		});

		it("uses default subdir when not provided", () => {
			const result = makeSessionFile(1, tempDir);
			expect(result).toContain("subagents");
		});

		it("throws on path traversal attempt", () => {
			expect(() => makeSessionFile(1, tempDir, "../../../etc")).toThrow();
		});
	});

	describe("cleanSessionDir()", () => {
		it("removes jsonl files", () => {
			const dir = join(tempDir, ".pi", "agent-sessions", "test");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "agent-1.jsonl"), "{}");
			writeFileSync(join(dir, "agent-2.jsonl"), "{}");
			writeFileSync(join(dir, "other.txt"), "text");

			cleanSessionDir(dir);

			expect(existsSync(join(dir, "agent-1.jsonl"))).toBe(false);
			expect(existsSync(join(dir, "agent-2.jsonl"))).toBe(false);
			expect(existsSync(join(dir, "other.txt"))).toBe(true);
		});

		it("handles non-existent directory", () => {
			expect(() => cleanSessionDir("/non/existent/path")).not.toThrow();
		});
	});

	describe("constants", () => {
		it("has correct timeout values", () => {
			expect(AGENT_JOIN_TIMEOUT_MS).toBe(15 * 60 * 1000);
			expect(AGENT_JOIN_POLL_INTERVAL_MS).toBe(500);
		});
	});
});

// ── Export test summary ──────────────────────────────────────────────────

console.log("✅ Base Agents unit tests loaded");
console.log("   Run with: bun test specs/base-agents.unit.test.ts");
