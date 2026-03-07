# Tool Policy Migration Summary

## Что было сделано

В репозитории внедрены 2 улучшения:

1. **Стандарты проектирования инструментов**
   - добавлен canonical doc: `tool-design-standards.md`
   - добавлен короткий digest: `agent_context.md`
   - `CLAUDE.md` и `README.md` обновлены ссылками на эти документы

2. **Оптимизация активных инструментов**
   - убран eager activation optional tools из `extensions/base-tools.ts`
   - добавлен shared helper: `extensions/lib/tool-contract.ts`
   - добавлены structured errors и более стабильные `details` в `base-tools.ts`
   - `extensions/system-select.ts` расширен поддержкой `tool_profile` / `tool_profiles`
   - часть `.pi/agents/*.md` переведена с длинных `tools:` списков на tool profiles

---

## Зачем это делать

Основная идея:
- tool definitions тоже тратят контекст;
- не надо держать все tools всегда активными;
- короткие и стабильные tool contracts лучше кэшируются и лучше выбираются моделью;
- агенту нужен короткий always-on digest и полный стандарт только по требованию.

---

## Какие файлы нужно добавить

### 1. `tool-design-standards.md`
Полный стандарт для tools.

Минимум разделов:
- Purpose
- Core principles
- Tool naming rules
- Tool description rules
- Input schema rules
- Response design rules
- Token-efficiency rules
- Error handling rules
- Tool invocation policy
- Mutating tools
- Versioning and compatibility
- Evaluation requirements
- PR checklist
- Anti-patterns

### 2. `agent_context.md`
Короткая выжимка на 15–20 строк:
- tool definitions consume context
- only relevant tools should be active
- prefer narrow tools
- prefer `search/list -> get/details`
- keep outputs concise
- use structured errors
- keep orchestration in code

### 3. `extensions/lib/tool-contract.ts`
Общий helper для контрактов:
- error codes
- structured error payload
- helper functions вроде `invalidArgument`, `notFound`, `rateLimited`
- helper для concise/stable details

---

## Какие файлы нужно изменить

### 1. `CLAUDE.md`
Добавить короткие правила:
- follow `tool-design-standards.md` for tool work
- use `agent_context.md` as short summary
- prefer `tool_profile` over long repeated `tools:` lists in agent files

### 2. `README.md`
Добавить ссылки на:
- `tool-design-standards.md`
- `agent_context.md`

### 3. `extensions/base-tools.ts`
Сделать 3 изменения:

#### a) убрать eager activation optional tools
Если extension автоматически активирует `grep/find/ls` или другие optional tools на старте — убрать это.

#### b) добавить structured errors
Заменить `throw new Error(...)` на helper-ошибки с полями:
- `code`
- `message`
- `action_hint`
- `retryable`

#### c) стабилизировать `details`
Для tool results добавить короткий `summary` и machine-stable payload.

---

## Profile-based activation через `system-select`

### Что добавить в `extensions/system-select.ts`

1. Поддержку frontmatter-полей:
- `tool_profile`
- `tool_profiles`
- fallback на старое `tools`

2. Таблицу профилей, например:

```ts
const TOOL_PROFILES = {
  core: ["read", "write", "edit", "bash"],
  exploration: ["grep", "find", "ls"],
  web: ["web_fetch", "ask_user"],
  planning: ["todo", "tilldone"],
  read_only: ["read", "grep", "find", "ls"],
  review: ["read", "bash", "grep", "find", "ls"],
  authoring: ["read", "write", "edit", "grep", "find", "ls"],
  builder: ["read", "write", "edit", "bash", "grep", "find", "ls"],
};
```

3. Логику выбора tools:
- если есть `tool_profile(s)` → резолвить profile tools
- иначе если есть `tools` → использовать их
- иначе → использовать default tools

4. Показ summary в `/system`:
- какие profiles используются
- сколько tools будет активно

---

## Как обновить agent files

Вместо:

```md
---
tools: read,write,edit,bash,grep,find,ls
---
```

использовать:

```md
---
tool_profile: builder
---
```

Примеры миграции:
- builder → `tool_profile: builder`
- planner → `tool_profile: read_only`
- reviewer → `tool_profile: review`
- documenter → `tool_profile: authoring`

Если у агента есть уникальный custom tool, лучше оставить explicit `tools:`.
Пример: оркестратор с `query_experts`.

---

## Рекомендуемый порядок внедрения

1. Добавить `tool-design-standards.md`
2. Добавить `agent_context.md`
3. Обновить `CLAUDE.md` и `README.md`
4. Добавить `extensions/lib/tool-contract.ts`
5. Убрать eager activation optional tools
6. Мигрировать `base-tools.ts` на structured errors + stable details
7. Добавить tool profiles в `system-select.ts`
8. Перевести agent frontmatter на `tool_profile`
9. Оставить explicit `tools:` только там, где profile не подходит

---

## Что проверить после миграции

- `/system` показывает более узкие наборы tools
- при переключении агента реально меняется active toolset
- optional tools не включаются автоматически без причины
- ошибки tools возвращаются в структурированной форме
- `details` у tools короткие и стабильные
- старые агенты с `tools:` продолжают работать

---

## Практический результат

После обновления:
- system prompt меньше раздувается;
- модель видит меньше нерелевантных tools;
- tool contracts становятся более предсказуемыми;
- проще добавлять новые tools без деградации качества;
- агентные профили становятся чище и легче поддерживаются.

---

## Коротко

Если переносить только суть:
- добавьте **полный стандарт** (`tool-design-standards.md`)
- добавьте **короткую выжимку** (`agent_context.md`)
- не держите все optional tools всегда активными
- введите **tool profiles** для agent personas
- стандартизируйте **ошибки** и **details** у tools
