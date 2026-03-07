# Pi vs CC — Extension Playground

Pi Coding Agent extension examples and experiments.

## Tooling
- **Package manager**: `bun` (not npm/yarn/pnpm)
- **Task runner**: `just` (see justfile)
- **Extensions run via**: `pi -e extensions/<name>.ts`

## Project Structure
- `extensions/` — Pi extension source files (.ts)
- `specs/` — Feature specifications
- `.pi/agents/` — Agent definitions for agent-team extension
- `.pi/agent-sessions/` — Ephemeral session files (gitignored)

## Conventions
- Extensions are standalone .ts files loaded by Pi's jiti runtime
- Available imports: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@mariozechner/pi-ai`, `@sinclair/typebox`, plus any deps in package.json
- Register tools at the top level of the extension function (not inside event handlers)
- Use `isToolCallEventType()` for type-safe tool_call event narrowing

## Extensions Overview

### Provider Extensions

#### `provider-kimi` — Moonshot AI Integration
Enhanced provider for Kimi models with advanced features:

```bash
# Quick start
just ext-provider-kimi

# Reasoning mode with K2 models
just ext-provider-kimi-reasoning

# Vision mode with K2.5
just ext-provider-kimi-vision
```

**Features:**
- **File API**: Automatic upload of large files (>50KB) to save tokens
- **Auto-context routing**: Smart model selection based on content size
- **Reasoning models**: K2 series with thinking mode support
- **Vision**: K2.5 supports image analysis
- **Tools**: `kimi_upload`, `kimi_search`, `/kimi-cleanup`

**Models:**
| Model | Context | Reasoning | Vision | Cost (in/out) |
|-------|---------|-----------|--------|---------------|
| moonshot-v1-8k | 8K | ❌ | ❌ | $0.3/$1.2 |
| moonshot-v1-32k | 32K | ❌ | ❌ | $0.6/$2.4 |
| moonshot-v1-128k | 128K | ❌ | ❌ | $1.2/$4.8 |
| kimi-k2-32k | 32K | ✅ | ❌ | $0.6/$2.4 |
| kimi-k2-128k | 128K | ✅ | ❌ | $1.2/$4.8 |
| kimi-k2.5 | 256K | ✅ | ✅ | $0.6/$3.0 |

See `specs/provider-kimi.md` for detailed documentation.

### UI Extensions

| Extension | Description |
|-----------|-------------|
| `minimal` | Clean UI with model name + context meter |
| `pure-focus` | Strip footer and status line entirely |
| `theme-cycler` | Ctrl+X forward, Ctrl+Q backward theme switching |
| `tool-counter` | Footer with tool call counts |
| `tool-counter-widget` | Below-editor widget with tool stats |
| `subagent-widget` | Live streaming progress for /sub command |
| `session-replay` | Scrollable timeline overlay of session history |

### Workflow Extensions

| Extension | Description |
|-----------|-------------|
| `tilldone` | Task-driven discipline — define tasks before working |
| `purpose-gate` | Declare intent before working with persistent widget |
| `agent-team` | Dispatcher orchestrator with team select and grid dashboard |
| `agent-chain` | Sequential pipeline orchestrator |
| `cross-agent` | Load commands from .claude/, .gemini/, .codex/ dirs |
| `pi-pi` | Meta-agent that builds Pi agents with parallel research |

### Safety Extensions

| Extension | Description |
|-----------|-------------|
| `damage-control` | Safety auditing for destructive operations |
| `system-select` | /system to pick an agent persona |

### Base Tools

`base-tools.ts` adds:
- `web_fetch` — URL fetching with HTML→Markdown conversion
- `todo` — Persistent task list with UI widget
- `ask_user` — Interactive dialogs with options

## Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# Required for Kimi provider
MOONSHOT_API_KEY=sk-your-key
```
