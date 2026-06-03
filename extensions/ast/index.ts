/**
 * ast — AST Search Tool Extension for Pi
 *
 * Searches code files using tree-sitter AST query patterns (S-expression format).
 * Thin wrapper over `npx tree-sitter query` — no compilation needed.
 *
 * Usage:
 *   pi -e extensions/ast/index.ts
 *
 * Or alongside base tools:
 *   pi -e extensions/ast/index.ts -e extensions/base/base-tools.ts
 *
 * Tool:
 *   ast_search — find AST nodes matching a tree-sitter query pattern
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerAstTool } from "./ast-tool.ts";

export { registerAstTool, AstSearchParams } from "./ast-tool.ts";
export type { AstMatch, AstSearchDetails } from "./ast-tool.ts";

export default function astExtension(pi: ExtensionAPI) {
	registerAstTool(pi);

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.notify("🔬 AST Search Tool loaded — tree-sitter query patterns", "info");
	});
}
