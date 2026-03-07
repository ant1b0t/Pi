# Implementation Plan: Tool Design Standards & Prompt-Efficient Policy Integration

This plan updates the original approach to follow the recommended integration model:

- keep the **full standard** as a canonical repo document;
- keep a **short operational digest** available to the agent by default;
- avoid injecting the full policy into the system prompt on every turn;
- use the full document **on demand** when designing, reviewing, or refactoring tools.

## Recommended Document Names

Instead of `rules.md`, use a more specific and durable name:

- **Canonical standard:** `tool-design-standards.md`
- **Compact digest:** `agent_context.md`

Why `tool-design-standards.md`:
- more descriptive than `rules.md`;
- clearer for humans and agents scanning the repo;
- scoped to the actual subject: tool design, contracts, and token efficiency;
- easier to reference from `CLAUDE.md`, PRs, and future specs without ambiguity.

---

## Goal

Reduce tool-related token overhead, improve tool selection accuracy, and standardize tool interaction contracts without bloating Pi's effective system prompt.

The target operating model is:

1. **Pi default system prompt** remains the runtime foundation.
2. **`CLAUDE.md`** remains the repo-level operating guide.
3. **`agent_context.md`** becomes the short, always-available policy digest.
4. **`tool-design-standards.md`** becomes the canonical, detailed standard loaded only when needed.

This is the preferred balance between quality, cache stability, and prompt efficiency.

---

## Phase 1: Policy Architecture

### 1.1 Create `tool-design-standards.md`
Establish the canonical standard for tool design in the repository.

- **Location**: `/tool-design-standards.md`
- **Role**: detailed reference for humans and agents
- **Usage model**: read on demand; do **not** inject wholesale into the system prompt

### Required sections
1. Purpose
2. Core principles
3. Tool naming rules
4. Tool description rules
5. Input schema rules
6. Response design rules
7. Token-efficiency rules
8. Error handling rules
9. Tool invocation policy
10. Mutating tools
11. Versioning and compatibility
12. Evaluation requirements
13. PR checklist
14. Anti-patterns

### Core content to include
- tool definitions consume context, not just messages;
- expose only relevant tools for the current step;
- keep tool descriptions and schemas stable for prompt caching;
- prefer narrow tools over god-tools;
- prefer `search/list -> get/details` over wide all-in-one retrieval;
- keep responses concise, high-signal, and ID-oriented;
- require structured, retry-friendly errors.

---

### 1.2 Create `agent_context.md`
Create the short policy digest for routine agent behavior.

- **Location**: `/agent_context.md`
- **Role**: prompt-sized operational summary
- **Usage model**: always available via repo instructions / lightweight prompt inclusion

### Content goals
Keep it to roughly 15-20 lines covering:
- tool definitions consume context;
- only relevant tools should be active;
- descriptions and schemas should remain stable;
- tools should have narrow responsibility;
- responses should be concise and high-signal;
- large outputs should use pagination, filters, and two-step fetches;
- errors should be structured and actionable;
- orchestration, retries, and batching belong in code where possible.

---

### 1.3 Update `CLAUDE.md`
Use `CLAUDE.md` as the routing layer between Pi runtime behavior and the new policy docs.

### Additions to make
- explicitly state that tool work must follow `tool-design-standards.md`;
- state that `agent_context.md` is the compact operational summary;
- instruct the agent to consult `tool-design-standards.md` when:
  - creating a new tool,
  - changing a tool schema,
  - changing tool descriptions,
  - changing response or error contracts,
  - reviewing tool-related PRs/specs.

### Important constraint
Do **not** copy the full standard into `CLAUDE.md`.
`CLAUDE.md` should reference and route, not duplicate.

---

### 1.4 Update `README.md`
Add `tool-design-standards.md` to the extension author/reference section.

### Purpose
- make the standard discoverable for humans;
- reduce drift between extension code and project expectations;
- make PR review expectations explicit.

---

## Phase 2: Prompt Integration Strategy

This phase implements the recommended favorite model:

- **`agent_context.md` = always-on or near-always-on**
- **`tool-design-standards.md` = on-demand**

### 2.1 Preferred integration mode
Use a lightweight integration path for `agent_context.md`:
- either mention it from `CLAUDE.md` as required reading for tool work,
- or inject a very short summary of it through an extension in `before_agent_start`,
- but keep the injected text compact and stable.

### 2.2 Do not inject the full standard
Avoid placing the full contents of `tool-design-standards.md` into:
- `.pi/SYSTEM.md`
- `APPEND_SYSTEM.md`
- `CLAUDE.md`
- `before_agent_start` prompt augmentation

### Why
- increases prompt overhead;
- duplicates information already available in repo docs;
- makes cache stability worse if the standard changes;
- conflicts with the research goal of minimizing tool-related context cost.

### 2.3 Optional extension support
If needed later, create a small extension that:
- appends a tiny policy note derived from `agent_context.md`;
- points the agent to `tool-design-standards.md` for full guidance;
- keeps the wording stable to preserve caching.

This is optional and should only be added if docs-only routing proves insufficient.

---

## Phase 3: Core Infrastructure

### 3.1 Create `/extensions/lib/tool-contract.ts`
Create shared utilities for consistent tool contracts.

### Deliverables
- `ToolErrorCode` enum or equivalent constants;
- helpers for structured errors:
  - `makeInvalidArgument`
  - `makeNotFound`
  - `makeUnauthorized`
  - `makeRateLimited`
  - `makeTemporaryUnavailable`
  - `makeInternalError`
- helpers for concise success payloads;
- truncation helpers;
- pagination helpers;
- optional shared types for `summary`, `id`, `items`, `next_cursor`, `truncated`.

### Purpose
This file becomes the implementation bridge between policy docs and extension code.

---

## Phase 4: Tool Audit & Migration

### 4.1 Audit existing tools against `tool-design-standards.md`
Review high-impact extensions first:
1. `extensions/base-tools.ts`
2. `extensions/provider-kimi.ts`
3. `extensions/subagent-widget.ts`
4. `extensions/agent-team.ts`
5. `extensions/tilldone.ts`

### Audit criteria
- narrow responsibility vs multiplexed behavior;
- quality and stability of descriptions;
- schema strictness and clarity;
- support for limits, filters, pagination, truncation;
- concise response design;
- structured error handling;
- stable IDs and predictable follow-up flow.

---

### 4.2 Refactor `extensions/base-tools.ts`
This is the first migration target because it sets patterns reused elsewhere.

### Changes to make
- standardize `web_fetch` success and error payloads;
- standardize `todo` result details and error handling;
- standardize `ask_user` response and error structure where applicable;
- preserve concise human-readable `content`, but make `details` machine-stable;
- document truncation behavior explicitly.

### Important policy change
Remove or redesign eager activation of `grep`, `find`, and `ls` on `session_start`.

Reason:
- always-on optional tools conflict with the research finding that tool definitions consume context;
- active toolsets should be minimized whenever possible.

---

## Phase 5: Active Tool Strategy

### 5.1 Move from eager activation to relevant tool subsets
Adopt a profile-based approach using `pi.setActiveTools()`.

### Initial profiles
- `core`: read, write, edit, bash
- `exploration`: grep, find, ls
- `web`: web_fetch, ask_user
- `planning`: todo, tilldone
- `orchestration`: dispatch/subagent-related tools

### Design rule
Profiles should be:
- small;
- stable;
- easy to reason about;
- selected based on task or agent persona.

---

### 5.2 Integrate with `extensions/system-select.ts`
Use the existing `setActiveTools()` mechanism to enforce narrower toolsets per agent/persona.

### Outcome
- the system prompt includes fewer tool definitions at once;
- tool selection becomes easier for the model;
- prompt overhead drops;
- the architecture aligns with the recommended Anthropic-oriented design.

---

## Phase 6: Evaluation & Maintenance

### 6.1 Add a tool compliance checklist
Add a practical review checklist to `tool-design-standards.md` and PR workflow.

### Checklist items
- Is the tool name compliant or explicitly marked as a legacy exception?
- Is the tool narrowly scoped?
- Does the description clearly explain when to use and not use it?
- Is the schema minimal and stable?
- Are large outputs bounded by default?
- Does the tool support filtering/pagination where needed?
- Is the response concise and high-signal?
- Are errors structured and actionable?
- Does the tool avoid god-tool behavior?

---

### 6.2 Define legacy compatibility rules
Do not force an immediate rename of existing tools like:
- `web_fetch`
- `ask_user`
- `todo`
- `tilldone`

### Policy
- treat them as legacy-compatible exceptions;
- enforce stronger naming rules for new tools;
- avoid unnecessary churn that would hurt prompt stability and developer ergonomics.

---

### 6.3 Define versioning policy
Treat these as contract-level changes:
- tool name changes;
- material description changes;
- schema changes;
- response shape changes;
- error shape changes.

### Rule
Breaking prompt-facing changes should be versioned deliberately rather than silently introduced.

---

## Priorities

### P0
- create `tool-design-standards.md`
- create `agent_context.md`
- update `CLAUDE.md` to reference both correctly
- update `README.md`

### P1
- create `extensions/lib/tool-contract.ts`
- migrate `extensions/base-tools.ts`
- standardize structured errors and concise details payloads

### P2
- implement profile-based active tool subsets
- integrate with `extensions/system-select.ts`
- remove or replace eager optional-tool activation

### P3
- audit and migrate secondary extensions
- optionally add lightweight extension-based prompt injection for `agent_context.md` if needed
- add evaluation docs/checklists for ongoing enforcement

---

## Final Architecture Summary

### Always available
- Pi default system prompt
- active tools only
- `CLAUDE.md`
- compact policy guidance from `agent_context.md`

### Loaded on demand
- `tool-design-standards.md`
- deeper specs and migration docs

### Key principle
Do not solve tool quality by permanently stuffing more policy into the prompt.

Instead:
- keep the runtime prompt small;
- keep the short policy always available;
- load the full standard only for tool-related work.
