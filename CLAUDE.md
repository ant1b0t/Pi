# Pi vs CC — Extension Playground

Pi Coding Agent extension examples and experiments.

## Tooling
- **Package manager**: `bun` (not npm/yarn/pnpm)
- **Task runner**: `just` (see justfile)
- **Extensions run via**: `pi -e extensions/<name>.ts` or `pi -e extensions/<subdir>/<name>.ts`

## Project Structure
- `extensions/` — Pi extension source files (.ts)
  - `base/` — Core infrastructure (base-tools, base-agents)
  - `examples/` — UI and workflow extension examples
  - `lib/` — Shared libraries and contracts
- `specs/` — Feature specifications
- `docs/` — Documentation (comparisons, reference, architecture)
- `.pi/agents/` — Agent definitions for agent-team extension
- `.pi/agent-sessions/` — Ephemeral session files (gitignored)

## Conventions
- Extensions are standalone .ts files loaded by Pi's jiti runtime
- Available imports: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@mariozechner/pi-ai`, `@sinclair/typebox`, plus any deps in package.json
- Register tools at the top level of the extension function (not inside event handlers)
- Use `isToolCallEventType()` for type-safe tool_call event narrowing
- For tool design and contract changes, follow `docs/reference/tool-design-standards.md`
- Use `docs/agent_context.md` as the short operational summary; read `docs/reference/tool-design-standards.md` when creating tools or changing names, descriptions, schemas, responses, or errors
- For agent personas in `.pi/agents/*.md`, prefer `tool_profile` over long repeated `tools:` lists when a standard profile fits

## Provider Extensions

### `opencode-zen` — OpenCode Zen Provider

OpenAI-compatible gateway provider for MiniMax via OpenCode Zen.

```bash
# Quick start
just ext-opencode-zen

# With base tools (todo, web_fetch, ask_user)
just ext-opencode-zen-full
```

**Features:**
- **Gateway**: `https://opencode.ai/zen/v1`
- **Protocol**: OpenAI-compatible chat completions
- **Models**:
  - `minimax-m2.5-free` (default)
  - `minimax-m2.5` (fallback)
- **Behavior**:
  - defaults to free model
  - falls back to paid model when the free model is unavailable or unsupported
  - does **not** silently fall back on auth/quota/rate-limit errors
- **Commands**:
  - `/opencode-zen-login`
  - `/opencode-zen-logout`
  - `/opencode-zen-status`

**Setup:**
```bash
# 1. Log in to OpenCode Zen and obtain your token/key:
#    https://opencode.ai/ru/zen
# 2. Add to .env:
OPENCODE_ZEN_API_KEY=your-key-here

# Optional overrides
OPENCODE_ZEN_BASE_URL=https://opencode.ai/zen/v1
OPENCODE_ZEN_DEFAULT_MODEL=minimax-m2.5-free
OPENCODE_ZEN_FALLBACK_MODEL=minimax-m2.5

# 3. Run
just ext-opencode-zen
```

**Notes:**
- Login / token page: https://opencode.ai/ru/zen
- Uses OpenCode Zen, not OpenCode Go, because MiniMax requires a different protocol surface.
- Treat `minimax-m2.5-free` as limited-time and unsuitable for sensitive production code without separate confirmation.

### `kimi` — Kimi For Coding Provider

Enhanced provider for Kimi For Coding (256K context) with File API support.

```bash
# Quick start
just ext-kimi

# With base tools (todo, web_fetch, ask_user)
just ext-kimi-full
```

**Features:**
- **Kimi For Coding API**: Anthropic-compatible endpoint (256K context)
- **File API**: Upload large files via Moonshot File API
- **Tools**: `kimi_upload` — upload files for efficient processing
- **Commands**:
  - `/kimi-cleanup` — delete uploaded files
  - `/kimi-files` — list uploaded files

**Setup:**
```bash
# 1. Get API key from https://www.kimi.com/code/console
# 2. Add to .env:
KIMI_API_KEY=sk-kimi-...

# 3. Run
just ext-kimi
```

**File Upload Usage:**
```
# Upload a large file
/kimi_upload path=/path/to/file.pdf

# Cleanup files after use
/kimi-cleanup

# List uploaded files
/kimi-files
```

**Model:** `kimi-for-coding` (automatically mapped to `k2p5`)
- Context: 256K tokens
- Max output: 32K tokens
- Supports: text, image input
- Reasoning: enabled

**Testing:** See `specs/provider-kimi-tests.md` for detailed test plan.

### `xiaomi` — Xiaomi MiMo Provider

OpenAI-compatible Xiaomi MiMo provider.

- **Run:** `just ext-xiaomi` / `just ext-xiaomi-full`
- **Auth:** `XIAOMI_API_KEY` or `/xiaomi-login`
- **Default model:** `mimo-v2-pro`
- **Confirmed:** streaming, tool calling, `developer` role, JSON mode, max output `131072`
- **Note:** `1,048,576` context is still unverified in public official docs

## UI Extensions

| Extension | Description |
|-----------|-------------|
| `minimal` | Clean UI with model name + context meter |
| `pure-focus` | Strip footer and status line entirely |
| `theme-cycler` | Ctrl+X forward, Ctrl+Q backward theme switching |
| `tool-counter` | Footer with tool call counts |
| `tool-counter-widget` | Below-editor widget with tool stats |
| `subagent-widget` | Live streaming progress for /sub command |
| `session-replay` | Scrollable timeline overlay of session history |

## Workflow Extensions

| Extension | Description |
|-----------|-------------|
| `tilldone` | Task-driven discipline — define tasks before working |
| `purpose-gate` | Declare intent before working with persistent widget |
| `agent-team` | Dispatcher orchestrator with team select and grid dashboard |
| `agent-chain` | Sequential pipeline orchestrator |
| `cross-agent` | Load commands from .claude/, .gemini/, .codex/ dirs |
| `pi-pi` | Meta-agent that builds Pi agents with parallel research |

## Safety Extensions

| Extension | Description |
|-----------|-------------|
| `damage-control` | Safety auditing for destructive operations |
| `system-select` | /system to pick an agent persona |

## Base Tools

`base-tools.ts` adds:
- `web_fetch` — URL fetching with HTML→Markdown conversion
- `todo` — Persistent task list with UI widget
- `ask_user` — Interactive dialogs with options

## Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# Required for Kimi provider
KIMI_API_KEY=sk-your-key-here

# Required for Xiaomi MiMo provider
XIAOMI_API_KEY=your-key-here
```
