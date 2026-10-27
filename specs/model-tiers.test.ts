import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import {
	loadModelTiers,
	resolveModel,
	resolveModelSelection,
	resolveThinkingLevel,
	reverseLookupTier,
	type ModelTiers,
	type ModelTierValue,
	type ThinkingLevel,
} from "../extensions/base/model-tiers.ts";

const tempDirs: string[] = [];

/**
 * loadModelTiers falls back to ~/.pi/model-tiers.json. Tests that assert a null
 * result are skipped when the machine has a valid home candidate.
 */
const homeTiersFile = path.resolve(homedir(), ".pi", "model-tiers.json");
const homeTiersExists = existsSync(homeTiersFile);

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeProjectDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-model-tiers-"));
	tempDirs.push(dir);
	mkdirSync(path.join(dir, ".pi"), { recursive: true });
	return dir;
}

function makeProject(config: unknown): string {
	const dir = makeProjectDir();
	writeFileSync(path.join(dir, ".pi", "model-tiers.json"), JSON.stringify(config), "utf-8");
	return dir;
}

function makeRawProject(raw: string): string {
	const dir = makeProjectDir();
	writeFileSync(path.join(dir, ".pi", "model-tiers.json"), raw, "utf-8");
	return dir;
}

function tiersOf(overrides: Partial<Record<"high" | "medium" | "low", ModelTierValue>> = {}): ModelTiers {
	return {
		high: overrides.high ?? "p/high",
		medium: overrides.medium ?? "p/medium",
		low: overrides.low ?? "p/low",
	};
}

// ── Loader ─────────────────────────────────────────────────────────────

describe("loadModelTiers", () => {
	it("preserves legacy string tiers", () => {
		const config = { high: "p/a", medium: "p/b", low: "p/c" };

		expect(loadModelTiers(makeProject(config))).toEqual(config);
	});

	it("preserves legacy array shapes and order", () => {
		const config = { high: ["p/a", "p/b"], medium: ["p/c"], low: ["p/d", "p/e", "p/f"] };

		expect(loadModelTiers(makeProject(config))).toEqual(config);
	});

	it("preserves entry objects and mixed arrays", () => {
		const config = {
			high: { model: "p/a", effort: "max" },
			medium: ["p/b", { model: "p/c", effort: "low" }, { model: "p/d" }],
			low: [{ model: "p/e", effort: "minimal" }],
		};

		expect(loadModelTiers(makeProject(config))).toEqual(config);
	});

	it("accepts every thinking level as effort", () => {
		const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		const config = {
			high: levels.map((effort, index) => ({ model: `p/m${index}`, effort })),
			medium: "p/b",
			low: "p/c",
		};

		expect(loadModelTiers(makeProject(config))).toEqual(config);
	});

	it("validates model strings by trimmed length but preserves them raw", () => {
		const config = { high: "  p/a  ", medium: "p/b", low: "p/c" };

		expect(loadModelTiers(makeProject(config))).toEqual(config);
	});

	it("preserves unknown entry keys and ignores extra top-level keys", () => {
		const config = {
			high: { model: "p/a", effort: "high", thinking: "max", provider: "x" },
			medium: "p/b",
			low: "p/c",
			version: 2,
		};

		expect(loadModelTiers(makeProject(config))).toEqual({
			high: { model: "p/a", effort: "high", thinking: "max", provider: "x" },
			medium: "p/b",
			low: "p/c",
		});
	});

	const invalidConfigs: Array<[string, unknown]> = [
		["unknown effort", { high: { model: "p/a", effort: "ultra" }, medium: "p/b", low: "p/c" }],
		["uppercase effort", { high: { model: "p/a", effort: "MAX" }, medium: "p/b", low: "p/c" }],
		["padded effort", { high: { model: "p/a", effort: " high " }, medium: "p/b", low: "p/c" }],
		["non-string effort", { high: { model: "p/a", effort: 3 }, medium: "p/b", low: "p/c" }],
		["null effort", { high: { model: "p/a", effort: null }, medium: "p/b", low: "p/c" }],
		["missing model", { high: { effort: "high" }, medium: "p/b", low: "p/c" }],
		["whitespace-only model", { high: "   ", medium: "p/b", low: "p/c" }],
		["whitespace model in object", { high: { model: " " }, medium: "p/b", low: "p/c" }],
		["empty array", { high: [], medium: "p/b", low: "p/c" }],
		["empty array item", { high: ["p/a", ""], medium: "p/b", low: "p/c" }],
		["nested array item", { high: [["p/a"]], medium: "p/b", low: "p/c" }],
		["null tier", { high: null, medium: "p/b", low: "p/c" }],
		["missing tier", { high: "p/a", medium: "p/b" }],
		["root string", "not-a-tier-object"],
		["root array", ["p/a", "p/b", "p/c"]],
		["root null", null],
	];

	for (const [name, config] of invalidConfigs) {
		it.skipIf(homeTiersExists)(`rejects ${name}`, () => {
			expect(loadModelTiers(makeProject(config))).toBeNull();
		});
	}

	it.skipIf(homeTiersExists)("rejects malformed JSON", () => {
		expect(loadModelTiers(makeRawProject("{ not json"))).toBeNull();
	});

	it.skipIf(homeTiersExists)("returns null when no candidate file exists", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pi-model-tiers-empty-"));
		tempDirs.push(dir);

		expect(loadModelTiers(dir)).toBeNull();
	});

	it.skipIf(!homeTiersExists)("falls back to the home candidate when the project file is invalid", () => {
		const invalidProject = makeProject({ high: [], medium: "p/b", low: "p/c" });

		expect(loadModelTiers(invalidProject)).toEqual(loadModelTiers(homedir()));
	});
});

// ── Tier defaults ──────────────────────────────────────────────────────

describe("resolveThinkingLevel", () => {
	it("keeps the legacy tier default map", () => {
		expect(resolveThinkingLevel("high")).toBe("high");
		expect(resolveThinkingLevel("medium")).toBe("xhigh");
		expect(resolveThinkingLevel("low")).toBe("high");
		expect(resolveThinkingLevel()).toBe("off");
	});
});

// ── Selection ──────────────────────────────────────────────────────────

describe("resolveModelSelection", () => {
	// Runs first so the medium round-robin counter is deterministic for the assertions below.
	it("keeps round-robin valid when the pool shrinks", () => {
		const three = tiersOf({ medium: ["m/a", "m/b", "m/c"] });
		const observed = [
			resolveModelSelection({ tier: "medium", tiers: three }).model,
			resolveModelSelection({ tier: "medium", tiers: three }).model,
			resolveModelSelection({ tier: "medium", tiers: three }).model,
		];
		// A full cycle of three calls leaves the counter where it started.
		expect([...new Set(observed)].sort()).toEqual(["m/a", "m/b", "m/c"]);
		expect(resolveModelSelection({ tier: "medium", tiers: three }).model).toBe(observed[0]);

		// Counter now points past observed[0]; shrink the pool and verify modulo bounds it.
		const startIndex = ["m/a", "m/b", "m/c"].indexOf(observed[0] as string);
		const two = tiersOf({ medium: ["m/a", "m/b"] });
		const firstAfterShrink = resolveModelSelection({ tier: "medium", tiers: two }).model;
		expect(firstAfterShrink).toBe(["m/a", "m/b"][(startIndex + 1) % 2]);

		const secondAfterShrink = resolveModelSelection({ tier: "medium", tiers: two }).model;
		expect(secondAfterShrink).toBe(["m/a", "m/b"][(startIndex + 2) % 2]);
	});

	it("selects model and effort atomically over one round-robin step", () => {
		const tiers = tiersOf({
			high: [
				{ model: "h/shared", effort: "low" },
				{ model: "h/shared", effort: "max" },
			],
		});

		const first = resolveModelSelection({ tier: "high", tiers });
		const second = resolveModelSelection({ tier: "high", tiers });

		expect(first.model).toBe("h/shared");
		expect(second.model).toBe("h/shared");
		expect([first.thinkingLevel, second.thinkingLevel].sort()).toEqual(["low", "max"]);

		// Next cycle repeats the same pairing: effort travels with its entry.
		const third = resolveModelSelection({ tier: "high", tiers });
		const fourth = resolveModelSelection({ tier: "high", tiers });
		expect(third.thinkingLevel).toBe(first.thinkingLevel);
		expect(fourth.thinkingLevel).toBe(second.thinkingLevel);
	});

	it("uses entry effort, else the tier default, when selecting by tier", () => {
		const tiers = tiersOf({
			high: [{ model: "h/a", effort: "max" }],
			low: ["l/a"],
		});

		expect(resolveModelSelection({ tier: "high", tiers })).toEqual({
			model: "h/a",
			thinkingLevel: "max",
			tier: "high",
		});
		expect(resolveModelSelection({ tier: "low", tiers })).toEqual({
			model: "l/a",
			thinkingLevel: "high",
			tier: "low",
		});
	});

	it("uses the fallback plus legacy tier effort when the tier has no config", () => {
		expect(resolveModelSelection({ tier: "medium", tiers: null, fallback: "p/parent" })).toEqual({
			model: "p/parent",
			thinkingLevel: "xhigh",
			tier: "medium",
		});
	});

	it("uses the fallback for an empty pool", () => {
		const tiers: ModelTiers = { high: [], medium: "p/medium", low: "p/low" };

		expect(resolveModelSelection({ tier: "high", tiers, fallback: "p/parent" })).toEqual({
			model: "p/parent",
			thinkingLevel: "high",
			tier: "high",
		});
	});

	it("never reverse-infers the fallback when no tier is requested", () => {
		const tiers = tiersOf({ high: { model: "p/parent", effort: "max" } });

		expect(resolveModelSelection({ tiers, fallback: "p/parent" })).toEqual({
			model: "p/parent",
			thinkingLevel: "off",
		});
		expect(resolveModelSelection({ tiers: null, fallback: "p/parent" })).toEqual({
			model: "p/parent",
			thinkingLevel: "off",
		});
		// The fallback is only recognized when it is passed as an explicit model.
		expect(reverseLookupTier("p/parent", tiers)).toBe("high");
	});

	it("uses the matching entry effort inside the requested tier for an explicit model", () => {
		const tiers = tiersOf({
			high: [{ model: "h/a", effort: "medium" }],
			low: [{ model: "l/a", effort: "minimal" }],
		});

		expect(resolveModelSelection({ model: "l/a", tier: "low", tiers })).toEqual({
			model: "l/a",
			thinkingLevel: "minimal",
			tier: "low",
		});
	});

	it("falls back to the tier default when the explicit model is not in that tier", () => {
		const tiers = tiersOf({ high: [{ model: "h/a", effort: "max" }] });

		expect(resolveModelSelection({ model: "h/a", tier: "low", tiers })).toEqual({
			model: "h/a",
			thinkingLevel: "high",
			tier: "low",
		});
	});

	it("uses the tier default when the matching entry has no effort", () => {
		const tiers = tiersOf({ low: ["l/a"] });

		expect(resolveModelSelection({ model: "l/a", tier: "low", tiers })).toEqual({
			model: "l/a",
			thinkingLevel: "high",
			tier: "low",
		});
	});

	it("infers the tier for an explicit model when no tier is given", () => {
		const tiers = tiersOf({ low: [{ model: "l/a", effort: "minimal" }] });

		expect(resolveModelSelection({ model: "l/a", tiers })).toEqual({
			model: "l/a",
			thinkingLevel: "minimal",
			tier: "low",
		});
	});

	it("uses off for an unknown explicit model", () => {
		const tiers = tiersOf();

		expect(resolveModelSelection({ model: "x/unknown", tiers })).toEqual({
			model: "x/unknown",
			thinkingLevel: "off",
		});
		expect(resolveModelSelection({ model: "x/unknown", tiers: null })).toEqual({
			model: "x/unknown",
			thinkingLevel: "off",
		});
	});

	it("prefers high → medium → low when a model appears in several tiers", () => {
		const tiers = tiersOf({
			medium: [{ model: "x/shared", effort: "low" }],
			low: [{ model: "x/shared", effort: "max" }],
		});

		expect(resolveModelSelection({ model: "x/shared", tiers })).toEqual({
			model: "x/shared",
			thinkingLevel: "low",
			tier: "medium",
		});
	});

	it("keeps the legacy tier effort for an explicit model without tier config", () => {
		expect(resolveModelSelection({ model: "x/any", tier: "medium", tiers: null })).toEqual({
			model: "x/any",
			thinkingLevel: "xhigh",
			tier: "medium",
		});
	});

	it("does not advance the round-robin counter for an explicit model", () => {
		const tiers = tiersOf({ high: ["h/a", "h/b"] });

		const first = resolveModelSelection({ tier: "high", tiers }).model;
		const second = resolveModelSelection({ tier: "high", tiers }).model;
		// Two calls complete a pool-of-two cycle; the counter is back where it started.
		expect(resolveModelSelection({ tier: "high", tiers }).model).toBe(first);

		resolveModelSelection({ model: "h/a", tier: "high", tiers });

		expect(resolveModelSelection({ tier: "high", tiers }).model).toBe(second);
	});
});

// ── Legacy wrapper ─────────────────────────────────────────────────────

describe("resolveModel", () => {
	it("keeps legacy priority: explicit model > tier > fallback", () => {
		const tiers = tiersOf({ low: ["l/a"] });

		expect(resolveModel({ model: "x/y", tier: "low", tiers, fallback: "p/f" })).toBe("x/y");
		expect(resolveModel({ tier: "low", tiers, fallback: "p/f" })).toBe("l/a");
		expect(resolveModel({ tiers, fallback: "p/f" })).toBe("p/f");
		expect(resolveModel({ tiers: null, fallback: "p/f" })).toBe("p/f");
	});

	it("delegates to the same round-robin cycle as resolveModelSelection", () => {
		const tiers = tiersOf({ low: ["l/a", "l/b"] });

		const viaWrapper = resolveModel({ tier: "low", tiers });
		const viaSelection = resolveModelSelection({ tier: "low", tiers });
		expect([viaWrapper, viaSelection.model].sort()).toEqual(["l/a", "l/b"]);

		expect(resolveModel({ tier: "low", tiers })).toBe(viaWrapper);
	});
});

// ── Reverse lookup ─────────────────────────────────────────────────────

describe("reverseLookupTier", () => {
	it("unwraps entry objects and matches the preserved model string exactly", () => {
		const tiers = tiersOf({
			medium: [{ model: "m/a", effort: "low" }],
			low: ["l/a", { model: "l/b", effort: "max" }],
		});

		expect(reverseLookupTier("m/a", tiers)).toBe("medium");
		expect(reverseLookupTier("l/b", tiers)).toBe("low");
		expect(reverseLookupTier("  m/a  ", tiers)).toBeUndefined();
		expect(reverseLookupTier("nope", tiers)).toBeUndefined();
		expect(reverseLookupTier("m/a", null)).toBeUndefined();
		expect(reverseLookupTier("", tiers)).toBeUndefined();
	});
});
