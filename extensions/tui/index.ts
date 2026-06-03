// ============================================================================
// TUI extension — shared rendering components for Pi extensions
//
// Адаптировано из oh-my-pi/packages/coding-agent/src/tui/
//
// Предоставляет:
// - renderStatusHeader   — заголовок с иконкой + описанием
// - renderFileList        — список файлов с иконками
// - renderDiff            — diff с +/- подсветкой
// - renderProgress        — прогресс-бар
// - renderResultsSummary  — итоговая строка
// - renderSection         — секция с заголовком
//
// Использование в других расширениях:
//   import { renderStatusHeader, renderResultsSummary } from "../tui";
// ============================================================================

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function tuiExtension(_pi: ExtensionAPI) {
	// TUI is a pure library — components are imported directly by other extensions.
}

// Re-export all components
export {
	renderStatusHeader,
	renderFileList,
	renderDiff,
	renderProgress,
	renderResultsSummary,
	renderSection,
	type StatusHeaderOpts,
	type FileEntry,
	type ProgressOpts,
	type ResultsSummaryOpts,
} from "./components";

export {
	statusIcon,
	formatDuration,
	renderProgressBar,
	treeList,
	hyperlink,
	treePrefix,
	treeBranch,
	getSpinnerFrame,
	ANSI,
	COLORS,
} from "./utils";

export {
	STATE_ICONS,
	SPINNER_FRAMES,
	TREE,
	type RenderState,
	type TreeContext,
} from "./types";
