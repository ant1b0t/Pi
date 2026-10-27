/**
 * model-tiers.ts — Model tier resolution for sub-agents
 *
 * Loads tier → model mappings from .pi/model-tiers.json in the project root.
 * Tiers: "high" | "medium" | "low"
 *
 * Each tier accepts:
 *   - a plain model string (legacy form)
 *   - an entry object { "model": "...", "effort": "<thinking level>" }
 *   - a non-empty array mixing both forms
 *
 * Example .pi/model-tiers.json:
 *   {
 *     "high":   "anthropic/claude-opus-4-5",
 *     "medium": [
 *       "anthropic/claude-sonnet-4-5",
 *       { "model": "anthropic/claude-sonnet-4-5", "effort": "max" }
 *     ],
 *     "low":    { "model": "anthropic/claude-haiku-3-5", "effort": "low" }
 *   }
 *
 * `effort` is optional and must be one of the exact lowercase thinking levels.
 * Without it the legacy tier default applies:
 *   high → "high", medium → "xhigh", low → "high", no tier → "off".
 *
 * Usage:
 *   const tiers = loadModelTiers(cwd);
 *   const selection = resolveModelSelection({ tier: "low", tiers, fallback: parentModel });
 *   selection.model         // selected model string
 *   selection.thinkingLevel // entry effort, else tier default
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────────────────

export type ModelTier = "high" | "medium" | "low";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** One model entry inside a tier. `effort` overrides the tier default thinking level. */
export interface ModelTierEntry {
	model: string;
	effort?: ThinkingLevel;
}

/** Tier value: legacy string, entry object, or a non-empty mixed array. */
export type ModelTierValue = string | ModelTierEntry | Array<string | ModelTierEntry>;

export interface ModelTiers {
	high: ModelTierValue;
	medium: ModelTierValue;
	low: ModelTierValue;
}

/** Result of one atomic tier/model/effort resolution. */
export interface ModelSelection {
	model: string | undefined;
	thinkingLevel: ThinkingLevel;
	tier?: ModelTier;
}

// ── Validation ─────────────────────────────────────────────────────────

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** A non-empty model string or an entry object with a valid optional effort. */
function isValidEntry(value: unknown): value is string | ModelTierEntry {
	if (typeof value === "string") return value.trim().length > 0;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const entry = value as Record<string, unknown>;
	if (typeof entry.model !== "string" || entry.model.trim().length === 0) return false;
	if (entry.effort === undefined) return true;
	return typeof entry.effort === "string" && THINKING_LEVELS.includes(entry.effort as ThinkingLevel);
}

/** A tier is one valid entry or a non-empty array of valid entries. */
function isValidTier(value: unknown): value is ModelTierValue {
	if (Array.isArray(value)) return value.length > 0 && value.every(isValidEntry);
	return isValidEntry(value);
}

/** Unwraps a tier value into entries. Strings are legacy single-model entries. */
function tierEntries(value: ModelTierValue): ModelTierEntry[] {
	const items = Array.isArray(value) ? value : [value];
	return items.map((item) => (typeof item === "string" ? { model: item } : item));
}

// ── Loader ─────────────────────────────────────────────────────────────

/**
 * Loads model tiers from .pi/model-tiers.json in the given project root.
 * Falls back to ~/.pi/model-tiers.json when the project candidate is invalid.
 * Returns null if no candidate exists or every candidate is malformed.
 * The original string/object/array shapes are preserved.
 */
export function loadModelTiers(cwd: string): ModelTiers | null {
	const candidatePaths = [
		path.resolve(cwd, ".pi", "model-tiers.json"),
		path.resolve(homedir(), ".pi", "model-tiers.json"),
	];

	for (const filePath of candidatePaths) {
		if (!existsSync(filePath)) continue;
		try {
			const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
			if (isValidTier(parsed?.high) && isValidTier(parsed?.medium) && isValidTier(parsed?.low)) {
				return { high: parsed.high, medium: parsed.medium, low: parsed.low };
			}
		} catch {
			// Try the next candidate path.
		}
	}
	return null;
}

// ── Resolver ───────────────────────────────────────────────────────────

const tierCounters: Record<ModelTier, number> = { high: 0, medium: 0, low: 0 };

/** Maps a model tier to Pi's default thinking level for sub-agent processes. */
export function resolveThinkingLevel(tier?: ModelTier): ThinkingLevel {
	if (tier === "high") return "high";
	if (tier === "medium") return "xhigh";
	if (tier === "low") return "high";
	return "off";
}

/** Finds an entry matching the model inside one specific tier. */
function findTierEntry(tier: ModelTier | undefined, model: string, tiers: ModelTiers | null): ModelTierEntry | undefined {
	if (!tier || !tiers) return undefined;
	return tierEntries(tiers[tier]).find((entry) => entry.model === model);
}

/**
 * Picks one entry from a tier via round-robin.
 * The counter is taken modulo the current pool size so a shrinking pool cannot
 * produce an out-of-range index.
 */
function selectTierEntry(tier: ModelTier, tiers: ModelTiers | null): ModelTierEntry | undefined {
	if (!tiers) return undefined;
	const entries = tierEntries(tiers[tier]);
	if (entries.length === 0) return undefined;
	const index = tierCounters[tier] % entries.length;
	tierCounters[tier] = (index + 1) % entries.length;
	return entries[index];
}

/**
 * Resolves model + thinking level atomically, so the round-robin counter advances
 * exactly once per selection and the effort stays attached to the selected entry.
 *
 * Priority:
 *   1. explicit model → effort of the matching entry in the requested tier, or in
 *      the tier inferred by reverseLookupTier when no tier is given; otherwise the
 *      tier default. Unknown explicit model without a tier → "off".
 *   2. tier → round-robin entry: its effort, else the tier default, else fallback.
 *   3. no model and no tier → fallback with thinking "off" (parent inheritance;
 *      the fallback is never reverse-inferred into a tier).
 */
export function resolveModelSelection(options: {
	model?: string;
	tier?: ModelTier;
	tiers: ModelTiers | null;
	fallback?: string;
}): ModelSelection {
	const { model, tier, tiers, fallback } = options;

	if (model) {
		const matchedTier = tier ?? reverseLookupTier(model, tiers);
		const entry = findTierEntry(matchedTier, model, tiers);
		const selection: ModelSelection = {
			model,
			thinkingLevel: entry?.effort ?? resolveThinkingLevel(matchedTier),
		};
		if (matchedTier) selection.tier = matchedTier;
		return selection;
	}

	if (tier) {
		const entry = selectTierEntry(tier, tiers);
		return {
			model: entry?.model ?? fallback,
			thinkingLevel: entry?.effort ?? resolveThinkingLevel(tier),
			tier,
		};
	}

	return { model: fallback, thinkingLevel: "off" };
}

/**
 * Resolves a model string from a tier + loaded tiers config.
 * Backward-compatible wrapper around resolveModelSelection: it delegates, so the
 * round-robin counter advances once and per-entry effort is skipped here.
 */
export function resolveModel(options: {
	model?: string;
	tier?: ModelTier;
	tiers: ModelTiers | null;
	fallback?: string;
}): string | undefined {
	return resolveModelSelection(options).model;
}

/**
 * Reverse-lookup tier by model string.
 * Matches both legacy string entries and entry objects, scanning high → medium → low.
 * Useful when agent passes model string directly instead of tier param.
 */
export function reverseLookupTier(model: string, tiers: ModelTiers | null): ModelTier | undefined {
	if (!tiers || !model) return undefined;
	for (const tier of ["high", "medium", "low"] as ModelTier[]) {
		if (tierEntries(tiers[tier]).some((entry) => entry.model === model)) return tier;
	}
	return undefined;
}

/**
 * Returns a human-readable label for a model string, for use in UI/logs.
 * e.g. "anthropic/claude-haiku-3-5" → "claude-haiku-3-5"
 */
/**
 * Extract a stable model string from Pi's current model object.
 * Tries common fields in order and avoids producing broken values like "provider/".
 */
export function currentModelString(model: any): string | undefined {
	if (!model) return undefined;

	const clean = (value: unknown): string | undefined => {
		if (typeof value !== "string") return undefined;
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	};

	const provider = clean(model.provider);
	const id = clean(model.id);
	const name = clean(model.name);
	const modelId = clean(model.modelId);
	const modelName = clean(model.model);

	if (provider && id) return `${provider}/${id}`;
	if (provider && name) return `${provider}/${name}`;
	if (provider && modelId) return `${provider}/${modelId}`;
	if (provider && modelName) return `${provider}/${modelName}`;
	return id ?? name ?? modelId ?? modelName;
}

/**
 * Returns a human-readable label for a model string, for use in UI/logs.
 * Handles malformed values like "provider/" by falling back to the last non-empty segment.
 */
export function modelLabel(model: string | undefined): string {
	if (!model) return "default";
	const parts = model.split("/").map((p) => p.trim()).filter(Boolean);
	return parts.length > 0 ? parts[parts.length - 1] : "default";
}
