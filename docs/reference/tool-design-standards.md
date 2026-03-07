# Tool Design Standards

## 1. Purpose

This document defines the canonical standards for designing, naming, documenting, and evolving tools in this repository.

Its goals are to:
- reduce prompt and tool-definition overhead;
- improve tool selection accuracy;
- make tool contracts predictable for models and humans;
- keep tool responses concise, high-signal, and retry-friendly;
- preserve prompt-cache stability by minimizing unnecessary contract churn.

This document is the **full reference**. It should be read on demand when creating, reviewing, or refactoring tools.

---

## 2. Core Principles

1. **Tool definitions consume context.** Context is spent not only on messages, but also on tool descriptions, input schemas, and prompt guidance.
2. **Only relevant tools should be active.** Prefer small, task-relevant toolsets over broad always-on catalogs.
3. **Stable contracts beat clever contracts.** Keep names, descriptions, and schemas stable unless a deliberate versioned change is required.
4. **Narrow tools outperform god-tools.** Split search/read/write/execute concerns whenever possible.
5. **Responses should be concise by default.** Return only what the model needs for the next step.
6. **Large data should be accessed in stages.** Prefer `search/list -> get/details` over one broad call.
7. **Orchestration belongs in code when possible.** Batch, retry, dedupe, loops, and polling should be handled by code, not multi-step model reasoning.

---

## 3. Tool Naming Rules

### Standard
New tools should use namespaced names in the form:

`<service>_<resource>_<action>`

### Examples
- `github_issue_list`
- `github_issue_get`
- `linear_ticket_update`
- `notion_page_search`

### Legacy compatibility
Existing tool names may remain for compatibility if already in use, for example:
- `web_fetch`
- `ask_user`
- `todo`
- `tilldone`

Do not rename legacy tools without a clear compatibility and migration plan.

### Anti-patterns
Avoid names like:
- `tool`
- `helper`
- `do_everything`
- `repo_tool`

---

## 4. Tool Description Rules

Each tool must describe:
- **purpose** — what it is for;
- **when to use** — positive selection guidance;
- **when not to use** — boundaries and alternatives;
- **what it returns** — concise result contract;
- **important parameters** — only the ones the model must reason about;
- **limits / truncation** — size caps, pagination, range rules;
- **common errors** — what can go wrong and how to recover.

### Description quality rules
- Prefer short, concrete sentences.
- Avoid vague marketing language.
- Avoid repeating schema text verbatim unless it adds selection clarity.
- Keep descriptions stable to preserve prompt caching.

### Examples requirement
Provide examples when a tool has:
- nested objects;
- optional fields that change behavior materially;
- format-sensitive input;
- pagination or cursor semantics;
- non-obvious mutating behavior.

---

## 5. Input Schema Rules

1. Use the smallest schema that supports the task.
2. Make required fields truly required.
3. Prefer enums over free-form strings where possible.
4. Avoid deeply nested objects unless they reduce ambiguity.
5. Add first-class controls for large data access:
   - `limit`
   - `filter`
   - `cursor` / `page`
   - `offset`
   - `range`
   - `fields`
6. Default to bounded outputs.
7. Keep schema wording stable to avoid unnecessary prompt-cache invalidation.

### Schema anti-patterns
- one giant union for many unrelated modes;
- hidden behavior controlled by undocumented flags;
- optional fields that silently change semantics;
- unbounded list operations with no limit.

---

## 6. Response Design Rules

### Default response mode
Responses should be **concise** by default.

### Required response properties
Responses should favor:
- `summary`
- stable `id` or `ids`
- compact `items`
- explicit `truncated` or pagination signals when applicable

### Response design principles
- Return only high-signal fields.
- Avoid raw dumps by default.
- Put bulky data behind follow-up detail fetches.
- Preserve stable IDs so the next call is predictable.

### Preferred patterns
#### Search / list
Return a short summary plus compact items:
- ID
- title / label
- minimal status or type metadata

#### Get / details
Return one entity in fuller form, but still avoid unrelated fields.

#### Mutations
Return:
- a short success summary;
- the affected ID;
- minimal status needed for follow-up.

### Repo implementation guidance
When Pi tools return `content` + `details`:
- `content` should stay short and human-readable;
- `details` should be stable and machine-usable.

---

## 7. Token-Efficiency Rules

1. Do not expose every tool at every step.
2. Prefer small active tool subsets.
3. Use `search/list -> get/details` for large domains.
4. Use pagination, filters, ranges, and truncation by default.
5. Avoid raw API payloads and large text dumps.
6. Move retries, batching, deduplication, and polling into code.
7. Keep `promptSnippet`, `promptGuidelines`, descriptions, and schemas stable.
8. Avoid large always-on policy text in the system prompt.

### Preferred repo policy
- keep a short operational digest available;
- load the full standard on demand;
- do not inject this entire document into the prompt every turn.

---

## 8. Error Handling Rules

Errors must be structured and actionable.

### Required fields
- `code`
- `message`
- `action_hint`
- `retryable`

### Standard categories
- `INVALID_ARGUMENT`
- `NOT_FOUND`
- `UNAUTHORIZED`
- `RATE_LIMITED`
- `CONFLICT`
- `TEMPORARY_UNAVAILABLE`
- `INTERNAL_ERROR`

### Error design principles
- `message` should explain what failed.
- `action_hint` should suggest the next valid action.
- `retryable` must reflect whether retrying makes sense.
- Avoid vague strings like `failed`, `bad request`, or `something went wrong`.

### Repo implementation guidance
If a tool must throw to signal failure, encode a structured error payload in a stable form that can be parsed and rendered consistently.

---

## 9. Tool Invocation Policy

1. Prefer read/search/list before mutate.
2. Ask the user when multiple valid interpretations exist.
3. Use tool follow-ups that are predictable from returned IDs.
4. Do not rely on the model to remember large prior payloads.
5. Avoid speculative writes when clarification is needed.

---

## 10. Mutating Tools

Mutating tools must:
- target an explicit resource;
- operate within a bounded scope;
- return a short success result with stable IDs;
- avoid combining lookup + mutation + execution in one call where possible.

Prefer preview / dry-run / explicit target parameters when applicable.

---

## 11. Versioning and Compatibility

Treat these as contract-level changes:
- tool name changes;
- material description changes;
- input schema changes;
- response shape changes;
- error shape changes.

### Rules
- breaking changes should be versioned deliberately;
- avoid unnecessary wording churn in prompt-visible fields;
- preserve backward compatibility for established tool names unless migration is intentional.

---

## 12. Evaluation Requirements

Evaluate new or changed tools for:
- prompt overhead;
- tool selection clarity;
- response compactness;
- quality of pagination and truncation behavior;
- retryability of errors;
- predictability of follow-up actions.

Where possible, verify:
- bounded default outputs;
- stable IDs in responses;
- structured errors for invalid input and missing resources;
- consistent behavior under truncation.

---

## 13. PR Checklist

- [ ] Tool name follows naming policy or is explicitly marked as a legacy exception
- [ ] Tool has narrow responsibility
- [ ] Description explains purpose, use, limits, and failure modes
- [ ] Schema is minimal and stable
- [ ] Large outputs are bounded by default
- [ ] Filtering / pagination / truncation exist where needed
- [ ] Response is concise and high-signal
- [ ] Stable IDs are returned for follow-up work
- [ ] Errors are structured and actionable
- [ ] Mutating behavior is explicit and bounded
- [ ] Prompt-visible contract changes were intentional and reviewed

---

## 14. Anti-Patterns

Avoid:
- god-tools that search, read, write, and execute in one contract;
- always returning full raw payloads;
- unstable descriptions and schema churn;
- missing limits on list/search operations;
- responses without stable IDs;
- vague error strings with no recovery hint;
- large policy text injected permanently into the prompt.

---

## Operational Relationship to Other Repo Docs

- `tool-design-standards.md` = canonical, detailed standard
- `agent_context.md` = short operational digest
- `CLAUDE.md` = routing layer that tells the agent when to consult each

Default expectation:
- keep `agent_context.md` compact and routinely available;
- load this full document only when tool-related work requires it.
