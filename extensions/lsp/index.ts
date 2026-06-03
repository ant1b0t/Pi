/**
 * lsp — LSP Tool Extension for Pi
 *
 * Spawns language servers (TypeScript, Python, Rust) via npx,
 * communicates over JSON-RPC stdio, and exposes LSP operations.
 *
 * Usage:
 *   pi -e extensions/lsp/index.ts
 *
 * Or alongside base tools:
 *   pi -e extensions/lsp/index.ts -e extensions/base/base-tools.ts
 *
 * Tool:
 *   lsp — diagnostics, definition, references, hover, symbols
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerLspTool } from "./lsp-tool.ts";

export { registerLspTool, LspParams } from "./lsp-tool.ts";

export default function lspExtension(pi: ExtensionAPI) {
	registerLspTool(pi);

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.notify("🔍 LSP Tool loaded — TypeScript, Python, Rust language servers", "info");
	});
}
