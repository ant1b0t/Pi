/**
 * config/index.ts — точка входа конфигурационной системы Pi-расширений
 *
 * Re-export всего API: схемы, типы, загрузчик.
 *
 * Пример использования:
 *   import { loadConfig, type MergedConfig } from "../config";
 *   const cfg = loadConfig(process.cwd());
 *   cfg.modelTiers?.high // → "claude-opus-4" или undefined
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function configExtension(_pi: ExtensionAPI) {
	// Config system is a pure library — no commands or tools to register.
	// Extensions import { loadConfig } from "../config" directly.
}

export { loadConfig, clearConfigCache } from "./config-loader";
export type { MergedConfig } from "./config-loader";

export {
	PiConfigSchema,
	ModelTiersSchema,
	AgentsConfigSchema,
	ToolsConfigSchema,
	SwarmConfigSchema,
	WorktreeConfigSchema,
	AstConfigSchema,
} from "./config-schema";

export type {
	PiConfig,
	ModelTiers,
	AgentsConfig,
	ToolsConfig,
	SwarmConfig,
	WorktreeConfig,
	AstConfig,
} from "./config-schema";
