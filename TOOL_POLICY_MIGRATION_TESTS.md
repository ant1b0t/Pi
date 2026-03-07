# Tool Policy Migration Tests

## Scope

Проверяются 4 блока:
- docs wiring
- structured tool contracts
- base-tools behavior
- profile-based activation через `system-select`

---

## 1. Docs wiring

### Test 1.1 — `CLAUDE.md` ссылается на policy docs
**Проверить:**
- есть ссылка на `tool-design-standards.md`
- есть ссылка на `agent_context.md`
- есть рекомендация предпочитать `tool_profile` вместо длинных `tools:` списков

**Ожидаемо:**
- все 3 пункта есть

### Test 1.2 — `README.md` ссылается на policy docs
**Проверить:**
- есть ссылка на `tool-design-standards.md`
- есть ссылка на `agent_context.md`
- описание `system-select` упоминает profile-based tool activation

**Ожидаемо:**
- все 3 пункта есть

---

## 2. Shared tool contract

### Test 2.1 — helper file существует
**Файл:** `extensions/lib/tool-contract.ts`

**Проверить наличие:**
- `ToolContractError`
- `makeToolError`
- `invalidArgument`
- `notFound`
- `unauthorized`
- `rateLimited`
- `temporaryUnavailable`
- `internalError`
- `parseToolErrorMessage`
- `conciseDetails`

**Ожидаемо:**
- все helper'ы экспортируются

### Test 2.2 — error shape стабильный
**Проверить:**
ошибки содержат согласованную структуру:
- `code`
- `message`
- `action_hint`
- `retryable`

**Ожидаемо:**
- shape одинаковый для всех helper'ов

---

## 3. `base-tools.ts`

### Test 3.1 — optional tools не активируются eager-способом
**Проверить:**
- в `session_start` больше нет авто-включения `grep`
- в `session_start` больше нет авто-включения `find`
- в `session_start` больше нет авто-включения `ls`

**Ожидаемо:**
- эти tools не добавляются автоматически

### Test 3.2 — `web_fetch` валидирует URL schema
**Шаги:**
1. вызвать `web_fetch` с `url=not-a-url`
2. вызвать `web_fetch` с `url=file:///tmp/a.txt`
3. вызвать `web_fetch` с `url=http://localhost:3000`

**Ожидаемо:**
- возвращается structured error
- сообщения соответствуют кейсу
- есть `action_hint`

### Test 3.3 — `web_fetch` валидирует timeout
**Шаги:**
1. вызвать `web_fetch` с `timeout=0`
2. вызвать `web_fetch` с `timeout=999`

**Ожидаемо:**
- structured error
- текст: timeout must be between 1 and 120 seconds

### Test 3.4 — `web_fetch` success details короткие и стабильные
**Шаги:**
1. вызвать `web_fetch` на публичном URL
2. проверить `details`

**Ожидаемо:**
- есть `summary`
- есть `url`
- есть `format`
- есть `contentType`
- есть `truncated`
- есть `bytes`
- нет лишнего noisy payload

### Test 3.5 — `todo add` требует `text`
**Шаги:**
1. вызвать `todo action=add` без `text`

**Ожидаемо:**
- structured error
- `code=invalid_argument`
- есть action hint

### Test 3.6 — `todo done/toggle/cancel` требуют `id`
**Шаги:**
1. вызвать `todo action=done` без `id`
2. вызвать `todo action=toggle` без `id`
3. вызвать `todo action=cancel` без `id`

**Ожидаемо:**
- structured error для каждого кейса

### Test 3.7 — `todo` возвращает summary в details
**Шаги:**
1. `todo list`
2. `todo add text="x"`
3. `todo done id=<id>`
4. `todo toggle id=<id>`
5. `todo cancel id=<id>`
6. `todo clear`

**Ожидаемо:**
- в `details` есть `summary`
- summary корректно отражает действие

### Test 3.8 — `todo` not found
**Шаги:**
1. вызвать `todo action=done id=99999`

**Ожидаемо:**
- structured error
- `code=not_found`
- hint предлагает вызвать `todo list`

### Test 3.9 — `ask_user` в non-interactive режиме
**Шаги:**
1. вызвать `ask_user` там, где UI недоступен

**Ожидаемо:**
- `details.summary = "User interaction unavailable"`
- `details.status = "unavailable"`
- `answer = null`

### Test 3.10 — `ask_user` cancel/select/input statuses
**Шаги:**
1. вызвать `ask_user` с options и отменить
2. вызвать `ask_user` с options и выбрать вариант
3. вызвать `ask_user` без options и ввести текст
4. вызвать `ask_user` без options и отменить

**Ожидаемо:**
- cancel → `status=cancelled`
- select/input → `status=answered`
- есть `summary`
- `renderResult` различает `unavailable`, `cancelled`, `answered`

### Test 3.11 — `todo` render не опирается на legacy `d.error`
**Проверить:**
- в `todo renderResult` нет ветки `if (d.error)`

**Ожидаемо:**
- рендер опирается на текущий contract, не на legacy shape

---

## 4. `system-select.ts`

### Test 4.1 — поддержка `tool_profile`
**Шаги:**
1. создать agent file с frontmatter:
   ```md
   ---
   name: test-builder
   tool_profile: builder
   ---
   Test agent
   ```
2. запустить `/system`
3. выбрать этого агента

**Ожидаемо:**
- активируются tools из profile `builder`

### Test 4.2 — поддержка `tool_profiles`
**Шаги:**
1. создать agent file с frontmatter:
   ```md
   ---
   name: test-mixed
   tool_profiles: core,exploration
   ---
   Test agent
   ```
2. выбрать его через `/system`

**Ожидаемо:**
- активируются tools из обоих profiles
- дубликаты удаляются

### Test 4.3 — fallback на explicit `tools`
**Шаги:**
1. создать agent file:
   ```md
   ---
   name: explicit-agent
   tools: read,query_experts
   ---
   Test agent
   ```
2. выбрать агента через `/system`

**Ожидаемо:**
- активируются именно explicit tools

### Test 4.4 — fallback на default tools
**Шаги:**
1. создать agent file без `tool_profile` и без `tools`
2. выбрать его через `/system`

**Ожидаемо:**
- используются default tools текущей сессии

### Test 4.5 — unknown profile не ломает fallback
**Шаги:**
1. создать agent file:
   ```md
   ---
   name: broken-profile
   tool_profile: unknown_profile
   tools: read,grep
   ---
   Test agent
   ```
2. выбрать его через `/system`

**Ожидаемо:**
- если profile не резолвится, используется explicit `tools`
- расширение не падает

### Test 4.6 — reset to default
**Шаги:**
1. выбрать любого profile-based агента
2. затем выбрать `Reset to Default`

**Ожидаемо:**
- активный system prompt сбрасывается
- active tools возвращаются к `defaultTools`
- status line обновляется

### Test 4.7 — `/system` UI показывает summary
**Проверить:**
- в списке выбора агента есть пометка вида:
  - `profiles=... · tools=N`
  - или `explicit tools=N`
  - или `default tools=N`

**Ожидаемо:**
- summary виден до выбора агента

### Test 4.8 — status/notify показывают размер toolset
**Шаги:**
1. выбрать агента с profile
2. сбросить на default

**Ожидаемо:**
- status содержит `tools=N`
- notify содержит `tools=N` или summary profile'ов

---

## 5. Agent frontmatter migration

### Test 5.1 — migrated agents используют `tool_profile`
**Проверить файлы:**
- `.pi/agents/builder.md`
- `.pi/agents/documenter.md`
- `.pi/agents/planner.md`
- `.pi/agents/plan-reviewer.md`
- `.pi/agents/scout.md`
- `.pi/agents/reviewer.md`
- `.pi/agents/red-team.md`

**Ожидаемо:**
- вместо длинного `tools:` списка используется `tool_profile`

### Test 5.2 — custom-tool agents остаются explicit
**Проверить:**
- `.pi/agents/pi-pi/pi-orchestrator.md`

**Ожидаемо:**
- explicit `tools:` сохранён, так как есть special tool `query_experts`

---

## 6. Backward compatibility

### Test 6.1 — старые agent files с `tools:` продолжают работать
**Шаги:**
1. оставить/создать agent только с `tools:`
2. выбрать через `/system`

**Ожидаемо:**
- agent корректно активируется
- tools применяются

### Test 6.2 — agent files без frontmatter не ломают scan
**Шаги:**
1. создать `.md` без frontmatter
2. перезапустить extension

**Ожидаемо:**
- agent всё равно сканируется
- name берётся из имени файла
- tools/profile пустые

---

## 7. Smoke regression

### Test 7.1 — session start без ошибок
**Шаги:**
1. запустить Pi с:
   - `extensions/base-tools.ts`
   - `extensions/system-select.ts`
2. открыть новую сессию

**Ожидаемо:**
- сессия стартует без runtime error
- `/system` доступен
- base tools работают

### Test 7.2 — docs и код не расходятся
**Проверить:**
- README описывает profile-based activation
- CLAUDE направляет к standard docs
- code реально поддерживает `tool_profile`

**Ожидаемо:**
- документация соответствует реализации

---

## 8. Optional automated checks

Если в окружении доступен runtime/tooling, дополнительно прогнать:

```bash
bun test
bunx tsc --noEmit
```

Если тестового раннера нет, минимум выполнить:
- grep по `tool_profile`
- grep по legacy `d.error`
- grep по `throw new Error(` в мигрированных tool files

---

## Pass criteria

Миграция считается успешной, если:
- policy docs подключены;
- `base-tools.ts` использует structured errors и stable details;
- optional tools не включаются автоматически;
- `system-select.ts` поддерживает tool profiles и fallback'и;
- agent personas переведены на profiles там, где это уместно;
- explicit tools сохранены для special-case агентов.
