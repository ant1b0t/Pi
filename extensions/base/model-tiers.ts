/**
 * model-tiers.ts — Model tier resolution for sub-agents
 *
 * Loads tier → model mappings from .pi/model-tiers.json in the project root.
 * Tiers: "high" | "medium" | "low"
 *
 * Example .pi/model-tiers.json:
 *   {
 *     "high":   "anthropic/claude-opus-4-5",
 *     "medium": "anthropic/claude-sonnet-4-5",
 *     "low":    "anthropic/claude-haiku-3-5"
 *   }
 *
 * Usage:
 *   const tiers = loadModelTiers(cwd);
 *   const model = resolveModel({ tier: "low", tiers, fallback: parentModel });
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────────────────

export type ModelTier = "high" | "medium" | "low";

export interface ModelTiers {
	high: string | string[];
	medium: string | string[];
	low: string | string[];
}

// ── Loader ─────────────────────────────────────────────────────────────

/**
 * Loads model tiers from .pi/model-tiers.json in the given project root.
 * Returns null if the file doesn't exist or is malformed.
 */
export function loadModelTiers(cwd: string): ModelTiers | null {
	const filePath = path.resolve(cwd, ".pi", "model-tiers.json");
	if (!existsSync(filePath)) return null;

	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw);

		const isValidTier = (val: any) => typeof val === "string" || (Array.isArray(val) && val.every(v => typeof v === "string"));

		if (isValidTier(parsed.high) && isValidTier(parsed.medium) && isValidTier(parsed.low)) {
			return { high: parsed.high, medium: parsed.medium, low: parsed.low };
		}
		return null;
	} catch {
		return null;
	}
}

// ── Resolver ───────────────────────────────────────────────────────────

const tierCounters: Record<ModelTier, number> = { high: 0, medium: 0, low: 0 };

/**
 * Resolves a model string from a tier + loaded tiers config.
 * If a tier contains an array of models, one is selected via Round-Robin.
 * This guarantees load-balancing and failover across multiple runs.
 *
 * Priority:
 *   1. explicit model string (bypass tiers entirely)
 *   2. tier → look up in tiers config
 *   3. fallback (parent's model or undefined)
 */
export function resolveModel(options: {
	model?: string;
	tier?: ModelTier;
	tiers: ModelTiers | null;
	fallback?: string;
}): string | undefined {
	const { model, tier, tiers, fallback } = options;

	if (model) return model;
	if (tier && tiers) {
		const selected = tiers[tier];
		if (Array.isArray(selected)) {
			const index = tierCounters[tier];
			tierCounters[tier] = (tierCounters[tier] + 1) % selected.length;
			return selected[index];
		}
		return selected;
	}
	return fallback;
}

/**
 * Reverse-lookup tier by model string.
 * If model matches an entry in tiers config, returns the tier name.
 * Useful when agent passes model string directly instead of tier param.
 */
export function reverseLookupTier(model: string, tiers: ModelTiers | null): ModelTier | undefined {
	if (!tiers || !model) return undefined;
	for (const tier of ["high", "medium", "low"] as ModelTier[]) {
		const val = tiers[tier];
		if (Array.isArray(val) ? val.includes(model) : val === model) return tier;
	}
	return undefined;
}

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
