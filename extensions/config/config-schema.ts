/**
 * config-schema.ts — TypeBox схемы для Pi-конфигурации
 *
 * Определяет JSON-схемы секций: modelTiers, agents, tools, swarm, worktree, ast.
 * Все секции опциональны на верхнем уровне, типы генерируются через Static.
 */

import { Type, type Static } from "typebox";

// ── Model Tiers ────────────────────────────────────────────────────────

export const ModelTiersSchema = Type.Object({
	high: Type.Union([Type.String(), Type.Array(Type.String())]),
	medium: Type.Union([Type.String(), Type.Array(Type.String())]),
	low: Type.Union([Type.String(), Type.Array(Type.String())]),
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
