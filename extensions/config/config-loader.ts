/**
 * config-loader.ts — Иерархический загрузчик Pi-конфигурации
 *
 * Иерархия (приоритет по возрастанию):
 *   1. ~/.pi/config.json (глобальный)
 *   2. <cwd>/.pi/config.json (проектный)
 *   3. Переменные окружения PI_*
 *
 * Формат JSON с секциями: modelTiers, agents, tools, swarm, worktree, ast.
 * Кеширование: Map по cwd, инвалидация по mtime обоих файлов.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import * as Value from "typebox/value";
import {
	PiConfigSchema,
	type ModelTiers,
	type AgentsConfig,
	type SwarmConfig,
	type WorktreeConfig,
	type AstConfig,
	type ToolsConfig,
} from "./config-schema";

// ── Типы ───────────────────────────────────────────────────────────────

export interface MergedConfig {
	modelTiers?: ModelTiers;
	agents?: AgentsConfig;
	tools?: ToolsConfig;
	swarm?: SwarmConfig;
	worktree?: WorktreeConfig;
	ast?: AstConfig;
}

// ── Кеш ────────────────────────────────────────────────────────────────

interface CacheEntry {
	config: MergedConfig;
	mtimes: [number, number]; // [globalMtime, projectMtime]
}

const cache = new Map<string, CacheEntry>();

// ── Хелперы ────────────────────────────────────────────────────────────

function readJson(path: string): Record<string, unknown> | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

function mtime(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

/** Парсит строку env-значения: boolean, number, JSON, иначе строка. */
function parseEnvValue(raw: string): unknown {
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (raw === "null") return null;
	if (raw === "undefined") return undefined;
	const num = Number(raw);
	if (!Number.isNaN(num) && raw.trim() !== "" && raw.trim().length > 0) return num;
	if ((raw.startsWith("[") && raw.endsWith("]")) || (raw.startsWith("{") && raw.endsWith("}"))) {
		try {
			return JSON.parse(raw);
		} catch {
			/* not JSON */
		}
	}
	return raw;
}

/** Маппинг известных PI_* env-вариаблов → dot-путь в конфиге. */
function envToConfigPath(key: string): string | null {
	const known: Record<string, string> = {
		PI_MODEL_TIERS_HIGH: "modelTiers.high",
		PI_MODEL_TIERS_MEDIUM: "modelTiers.medium",
		PI_MODEL_TIERS_LOW: "modelTiers.low",
		PI_AGENTS_INCLUDE_GLOBAL: "agents.includeGlobal",
		PI_AGENTS_DIRS: "agents.dirs",
		PI_SWARM_DIR: "swarm.dir",
		PI_WORKTREE_DIR: "worktree.dir",
		PI_AST_DIR: "ast.dir",
	};

	if (key in known) return known[key];

	// Динамика: PI_TOOLS_* → tools.<rest>
	if (key.startsWith("PI_TOOLS_")) {
		return "tools." + key.slice(9).toLowerCase().replace(/_/g, ".");
	}
	// Динамика: PI_MODEL_TIERS_<custom> → modelTiers.<custom>
	if (key.startsWith("PI_MODEL_TIERS_") && !known[key]) {
		return "modelTiers." + key.slice(15).toLowerCase();
	}
	return null;
}

/** Устанавливает значение по dot-пути (мутирует объект). */
function setNested(obj: Record<string, unknown>, path: string, value: unknown): void {
	const parts = path.split(".");
	let current = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		if (!(parts[i] in current) || typeof current[parts[i]] !== "object" || current[parts[i]] === null) {
			current[parts[i]] = {};
		}
		current = current[parts[i]] as Record<string, unknown>;
	}
	current[parts[parts.length - 1]] = value;
}

/** Собирает все PI_* env-вариаблы и маппит в конфиг. */
function collectEnvOverrides(): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("PI_") || value === undefined || value === "") continue;
		const path = envToConfigPath(key);
		if (path) setNested(result, path, parseEnvValue(value));
	}
	return result;
}

/** Deep-merge: значения из source с более высоким приоритетом перезаписывают target. */
function deepMerge(...sources: Record<string, unknown>[]): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const source of sources) {
		if (!source) continue;
		for (const [key, value] of Object.entries(source)) {
			if (value !== null && typeof value === "object" && !Array.isArray(value)) {
				result[key] = deepMerge(
					(result[key] as Record<string, unknown>) ?? {},
					value as Record<string, unknown>,
				);
			} else if (value !== undefined) {
				result[key] = value;
			}
		}
	}
	return result;
}

// ── Основной API ───────────────────────────────────────────────────────

/**
 * Загружает сконфигурированную конфигурацию для указанной директории.
 * Кеширует результат, инвалидирует по mtime ~/.pi/config.json и .pi/config.json.
 *
 * @param cwd - корневая директория проекта
 * @returns MergedConfig — типизированная, очищенная от лишних полей
 */
export function loadConfig(cwd: string): MergedConfig {
	const globalPath = resolve(homedir(), ".pi", "config.json");
	const projectPath = resolve(cwd, ".pi", "config.json");

	const currentMtimes: [number, number] = [mtime(globalPath), mtime(projectPath)];
	const cacheKey = `${globalPath}:${projectPath}`;

	// Проверка кеша
	const cached = cache.get(cacheKey);
	if (cached) {
		if (cached.mtimes[0] === currentMtimes[0] && cached.mtimes[1] === currentMtimes[1]) {
			return cached.config;
		}
	}

	// Чтение
	const global = readJson(globalPath);
	const project = readJson(projectPath);
	const env = collectEnvOverrides();

	// Слияние: env > project > global
	const merged = deepMerge(global ?? {}, project ?? {}, env);

	// Валидация через TypeBox: Clean (удалить лишнее) + Default (заполнить defaults) + Errors (проверить)
	const cleaned = Value.Clean(PiConfigSchema, structuredClone(merged));
	const defaulted = Value.Default(PiConfigSchema, cleaned);

	const errors = Value.Errors(PiConfigSchema, defaulted);
	if (errors.length > 0) {
		console.warn(
			"[pi-config] Validation errors:",
			errors.map((e) => `${e.path}: ${e.message}`).join("; "),
		);
	}

	const config = defaulted as unknown as MergedConfig;

	// Кеширование
	cache.set(cacheKey, { config, mtimes: currentMtimes });

	return config;
}

/**
 * Очищает кеш конфигурации (для тестов или ручной инвалидации).
 */
export function clearConfigCache(): void {
	cache.clear();
}
