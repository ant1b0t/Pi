/**
 * Caveman — terse output mode for Pi
 *
 * Inspired by JuliusBrussee/caveman. This is a Pi-native rules/command layer,
 * not a model provider: it injects response-style instructions and exposes
 * slash commands for mode switching and terse commit/review workflows.
 *
 * Usage: pi -e extensions/examples/caveman.ts -e extensions/examples/minimal.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { applyExtensionDefaults } from "./themeMap.ts";

type CavemanMode = "lite" | "full" | "ultra" | "wenyan-lite" | "wenyan" | "wenyan-ultra";

const STATE_TYPE = "caveman-state";
const DEFAULT_MODE: CavemanMode = "full";

const MODE_ALIASES: Record<string, CavemanMode | null> = {
  on: DEFAULT_MODE,
  yes: DEFAULT_MODE,
  start: DEFAULT_MODE,
  enable: DEFAULT_MODE,
  enabled: DEFAULT_MODE,
  lite: "lite",
  light: "lite",
  full: "full",
  default: "full",
  ultra: "ultra",
  terse: "ultra",
  wenyan: "wenyan",
  "wenyan-full": "wenyan",
  "wenyan-lite": "wenyan-lite",
  "wenyan-light": "wenyan-lite",
  "wenyan-ultra": "wenyan-ultra",
  off: null,
  stop: null,
  normal: null,
  disable: null,
  disabled: null,
};

const MODE_DESCRIPTIONS: Record<CavemanMode, string> = {
  lite: "Drop filler, keep grammar. Professional, concise.",
  full: "Default caveman. Fragments OK. Technical, terse.",
  ultra: "Maximum compression. Telegraphic, abbreviate when safe.",
  "wenyan-lite": "Semi-classical terse style. Use sparingly, keep clarity.",
  wenyan: "Classical Chinese compression. Preserve technical terms exactly.",
  "wenyan-ultra": "Extreme classical compression. Only when clarity survives.",
};

const BASE_RULES = `
<caveman-style>
Terse like caveman. Technical substance exact. Only fluff die.
Drop: articles, filler (just/really/basically), pleasantries, hedging, throat-clearing.
Fragments OK. Short synonyms. Pattern: [thing] [action] [reason]. [next step].
Preserve: code, commands, file paths, URLs, API names, error text, safety warnings, requirements.
Do not omit critical context. If user asks for depth, answer complete but compressed.
Code blocks unchanged except requested edits. No fake ignorance. No “as an AI”.
Off triggers: “stop caveman”, “normal mode”, or /caveman off.
</caveman-style>`;

const MODE_RULES: Record<CavemanMode, string> = {
  lite: "Mode: LITE. Keep normal grammar. Remove fluff. 1–3 short paragraphs or bullets.",
  full: "Mode: FULL. Use compact fragments. Prefer bullets. No intro/outro unless useful.",
  ultra: "Mode: ULTRA. Telegraphic. Min words. Symbols OK when unambiguous. No prose padding.",
  "wenyan-lite": "Mode: WENYAN-LITE. Semi-classical compression. Keep technical names in original spelling.",
  wenyan: "Mode: WENYAN. Classical terse style. Technical identifiers unchanged. Clarity over poetry.",
  "wenyan-ultra": "Mode: WENYAN-ULTRA. Extreme compression. Use only enough words for exact meaning.",
};

function resolveDefaultMode(): CavemanMode | null {
  const raw = (process.env.CAVEMAN_DEFAULT_MODE || DEFAULT_MODE).trim().toLowerCase();
  if (raw === "off" || raw === "normal" || raw === "disabled") return null;
  return MODE_ALIASES[raw] ?? DEFAULT_MODE;
}

function normalizeMode(value: string): CavemanMode | null | undefined {
  return MODE_ALIASES[value.trim().toLowerCase()];
}

function modeLabel(mode: CavemanMode | null): string {
  return mode ? `CAVEMAN:${mode.toUpperCase()}` : "CAVEMAN:OFF";
}

function buildPrompt(mode: CavemanMode): string {
  return `${BASE_RULES}\n${MODE_RULES[mode]}\nACTIVE EVERY RESPONSE until disabled.`;
}

function helpText(mode: CavemanMode | null): string {
  return [
    `Caveman status: ${modeLabel(mode)}`,
    "",
    "Commands:",
    "  /caveman                 pick mode",
    "  /caveman lite|full|ultra set mode",
    "  /caveman wenyan[-lite|-ultra]",
    "  /caveman off             normal mode",
    "  /caveman-commit [focus]  terse commit message",
    "  /caveman-review [target] one-line review findings",
    "  /caveman-compress <file> compress docs/memory file",
    "",
    "Triggers: “talk like caveman”, “less tokens please”, “stop caveman”, “normal mode”.",
  ].join("\n");
}

function restoreState(ctx: ExtensionContext): CavemanMode | null | undefined {
  const entry = ctx.sessionManager
    .getBranch()
    .filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === STATE_TYPE)
    .pop() as { data?: { mode?: string | null } } | undefined;
  if (!entry) return undefined;
  const mode = normalizeMode(String(entry.data?.mode ?? "off"));
  return mode === undefined ? undefined : mode;
}

function updateStatus(ctx: ExtensionContext, mode: CavemanMode | null): void {
  ctx.ui.setStatus("caveman", modeLabel(mode));
}

function persist(pi: ExtensionAPI, mode: CavemanMode | null): void {
  pi.appendEntry(STATE_TYPE, { mode });
}

function setMode(pi: ExtensionAPI, ctx: ExtensionContext, mode: CavemanMode | null, notify = true): void {
  persist(pi, mode);
  updateStatus(ctx, mode);
  if (!notify) return;

  if (mode) {
    ctx.ui.notify(`${modeLabel(mode)} enabled\n${MODE_DESCRIPTIONS[mode]}`, "info");
  } else {
    ctx.ui.notify("CAVEMAN disabled. Normal response style restored.", "info");
  }
}

async function chooseMode(ctx: ExtensionContext, currentMode: CavemanMode | null): Promise<CavemanMode | null | undefined> {
  if (!ctx.hasUI) return currentMode ?? DEFAULT_MODE;

  const options = [
    "off — normal mode",
    ...Object.entries(MODE_DESCRIPTIONS).map(([mode, description]) => `${mode} — ${description}`),
  ];
  const choice = await ctx.ui.select("Caveman mode", options);
  if (choice === undefined) return undefined;
  if (choice.startsWith("off")) return null;
  return choice.split(" — ")[0] as CavemanMode;
}

function sendInstruction(pi: ExtensionAPI, ctx: ExtensionContext, text: string): void {
  if (ctx.isIdle()) {
    pi.sendUserMessage(text);
  } else {
    pi.sendUserMessage(text, { deliverAs: "followUp" });
    ctx.ui.notify("Queued after current turn", "info");
  }
}

export default function (pi: ExtensionAPI) {
  let activeMode: CavemanMode | null = resolveDefaultMode();

  pi.on("session_start", async (_event, ctx) => {
    applyExtensionDefaults(import.meta.url, ctx);

    activeMode = resolveDefaultMode();
    const restored = restoreState(ctx);
    if (restored !== undefined) activeMode = restored;

    updateStatus(ctx, activeMode);
    ctx.ui.notify(`${modeLabel(activeMode)} loaded. Use /caveman to switch.`, "info");
  });

  pi.registerCommand("caveman", {
    description: "Switch terse Caveman response mode",
    getArgumentCompletions: (prefix: string) => {
      const values = ["lite", "full", "ultra", "wenyan-lite", "wenyan", "wenyan-ultra", "off", "status", "help"];
      const items = values
        .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
        .map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      if (arg === "help" || arg === "?") {
        ctx.ui.notify(helpText(activeMode), "info");
        return;
      }

      if (arg === "status") {
        ctx.ui.notify(`${modeLabel(activeMode)}\n${activeMode ? MODE_DESCRIPTIONS[activeMode] : "Normal mode."}`, "info");
        return;
      }

      const nextMode = arg ? normalizeMode(arg) : await chooseMode(ctx, activeMode);
      if (nextMode === undefined) {
        ctx.ui.notify(`Unknown caveman mode: ${arg}\nUse /caveman help.`, "warning");
        return;
      }

      activeMode = nextMode;
      setMode(pi, ctx, activeMode);
    },
  });

  pi.registerCommand("caveman-help", {
    description: "Show Caveman quick reference",
    handler: async (_args, ctx) => ctx.ui.notify(helpText(activeMode), "info"),
  });

  pi.registerCommand("caveman-commit", {
    description: "Generate a terse commit message for current changes",
    handler: async (args, ctx) => {
      sendInstruction(
        pi,
        ctx,
        [
          "Generate terse commit message for current git changes.",
          "Inspect git status/diff if needed.",
          "Obey repository commit language/conventions. Prefer concise past tense. Subject <=50 chars when possible.",
          "Output only commit message, no explanation.",
          args.trim() ? `Focus: ${args.trim()}` : "",
        ].filter(Boolean).join("\n"),
      );
    },
  });

  pi.registerCommand("caveman-review", {
    description: "Review changes with concise one-line findings",
    handler: async (args, ctx) => {
      sendInstruction(
        pi,
        ctx,
        [
          "Review current changes tersely.",
          "Output only actionable findings. One line each: file:line severity issue fix.",
          "No findings? Say: No issues found.",
          args.trim() ? `Target/focus: ${args.trim()}` : "",
        ].filter(Boolean).join("\n"),
      );
    },
  });

  pi.registerCommand("caveman-compress", {
    description: "Compress a docs/memory file in Caveman style with backup",
    handler: async (args, ctx) => {
      const file = args.trim();
      if (!file) {
        ctx.ui.notify("Usage: /caveman-compress <file>", "warning");
        return;
      }

      sendInstruction(
        pi,
        ctx,
        [
          `Compress ${file} in Caveman style to reduce prompt tokens.`,
          `First create backup ${file}.original.md if it does not exist.`,
          "Preserve code blocks, commands, URLs, file paths, headings, dates, version numbers, frontmatter, and exact technical meaning.",
          "Only compress prose. Show diff summary after edit.",
        ].join("\n"),
      );
    },
  });

  pi.on("input", async (event, ctx) => {
    const text = event.text.trim().toLowerCase();
    if (event.source === "extension") return { action: "continue" as const };

    if (text === "stop caveman" || text === "normal mode") {
      activeMode = null;
      setMode(pi, ctx, activeMode);
      return { action: "handled" as const };
    }

    if (text.includes("talk like caveman") || text.includes("caveman mode") || text.includes("less tokens please")) {
      if (!activeMode) {
        activeMode = DEFAULT_MODE;
        setMode(pi, ctx, activeMode);
      }
    }

    return { action: "continue" as const };
  });

  pi.on("before_agent_start", async (event) => {
    if (!activeMode) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildPrompt(activeMode)}`,
    };
  });
}
