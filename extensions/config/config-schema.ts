/**
 * config-schema.ts — TypeBox схемы для Pi-конфигурации
 *
 * Определяет JSON-схемы секций: modelTiers, agents, tools, swarm, worktree, ast.
 * Все секции опциональны на верхнем уровне, типы генерируются через Static.
 */

import { Type, type Static } from "typebox";

// ── Model Tiers ────────────────────────────────────────────────────────

/**
 * Уровень thinking для записи tier'а.
 * Допустимые значения совпадают с ThinkingLevel из model-tiers.ts.
 */
export const ModelTierEffortSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);

/** Непустая (после trim) строка модели. */
const ModelStringSchema = Type.String({
	pattern: "\\S",
	description: "Model string, non-empty after trimming",
});

/**
 * Запись tier'а: строка модели или объект { model, effort? }.
 * effort опционален — при отсутствии действует legacy-маппинг tier'а.
 */
export const ModelTierEntrySchema = Type.Union([
	ModelStringSchema,
	Type.Object({
		model: ModelStringSchema,
		effort: Type.Optional(ModelTierEffortSchema),
	}),
]);

export type ModelTierEntry = Static<typeof ModelTierEntrySchema>;

/** Tier — одна запись или непустой массив записей (смешанные массивы допустимы). */
const ModelTierValueSchema = Type.Union([
	ModelTierEntrySchema,
	Type.Array(ModelTierEntrySchema, { minItems: 1 }),
]);

export const ModelTiersSchema = Type.Object({
	high: ModelTierValueSchema,
	medium: ModelTierValueSchema,
	low: ModelTierValueSchema,
});

export type ModelTiers = Static<typeof ModelTiersSchema>;

// ── Agents ─────────────────────────────────────────────────────────────

export const AgentsConfigSchema = Type.Object({
	includeGlobal: Type.Optional(Type.Boolean({ default: true })),
	dirs: Type.Optional(Type.Array(Type.String())),
});

export type AgentsConfig = Static<typeof AgentsConfigSchema>;

// ── Tools ──────────────────────────────────────────────────────────────

export const ToolsConfigSchema = Type.Record(Type.String(), Type.Unknown());

export type ToolsConfig = Static<typeof ToolsConfigSchema>;

// ── Swarm ──────────────────────────────────────────────────────────────

export const SwarmConfigSchema = Type.Object({
	dir: Type.Optional(Type.String()),
});

export type SwarmConfig = Static<typeof SwarmConfigSchema>;

// ── Worktree ───────────────────────────────────────────────────────────

export const WorktreeConfigSchema = Type.Object({
	dir: Type.Optional(Type.String()),
});

export type WorktreeConfig = Static<typeof WorktreeConfigSchema>;

// ── AST ────────────────────────────────────────────────────────────────

export const AstConfigSchema = Type.Object({
	dir: Type.Optional(Type.String()),
});

export type AstConfig = Static<typeof AstConfigSchema>;

// ── Root config ────────────────────────────────────────────────────────

export const PiConfigSchema = Type.Object({
	modelTiers: Type.Optional(ModelTiersSchema),
	agents: Type.Optional(AgentsConfigSchema),
	tools: Type.Optional(ToolsConfigSchema),
	swarm: Type.Optional(SwarmConfigSchema),
	worktree: Type.Optional(WorktreeConfigSchema),
	ast: Type.Optional(AstConfigSchema),
});

export type PiConfig = Static<typeof PiConfigSchema>;
