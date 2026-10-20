# Base Agents — Sub-Agent Orchestration for Pi

Модульная система саб-агентов для Pi Coding Agent. Позволяет создавать, управлять и оркестрировать фоновыми агентами с различными наборами инструментов.

## 📁 Структура

| Файл | Назначение | Экспорты |
|------|------------|----------|
| `base-agents.ts` | Основной файл с инструментами | `agent_spawn`, `agent_join`, `agent_result`, `agent_list`, `agent_continue` |
| `agent-runner.ts` | Запуск процессов и сессии | `spawnPiProcess`, `makeSessionFile`, `resolveToolsParam` |
| `agent-events.ts` | Парсинг событий | `parseAgentEvent`, `extractTerminalResultFromFile` |
| `agent-completion.ts` | Completion envelope и persistence | `persistCompletionEnvelope`, `readCompletionEnvelope` |
| `agent-tags.ts` | Теги → инструменты | `resolveTagsToTools`, `getBuiltinTools` |
| `coordinator-mode.ts` | Фазы orchestration | `normalizePhase`, `buildPhaseGuidance`, `validatePhaseTransition` |
| `fork-context.ts` | Форк контекста родителя | `normalizeSpawnMode`, `buildForkContextPrompt` |
| `model-tiers.ts` | Уровни моделей | `loadModelTiers`, `resolveModel`, `currentModelString` |
| `agent-defs.ts` | Парсинг .md агентов | `parseAgentFile`, `scanAgentDirs` |
| `themeMap.ts` | UI темы | `applyExtensionDefaults` |
| `tool-contract.ts` | Контракты ошибок | `notFound`, `unauthorized`, `rateLimited` |

## 🚀 Быстрый старт

### 1. Запуск base-agents

```bash
pi -e extensions/base/base-agents.ts
```

### 2. Доступные инструменты

```typescript
// Создать агента
agent_spawn({
  tags: "Bash,Web",      // Теги инструментов
  task: "Find all TODOs", // Задание
  name: "todo-finder"     // Опциональное имя
})

// Дождаться завершения (по умолчанию до 20 минут; ожидание не останавливает агента)
agent_join({
  id: 1,
  timeoutMs: 20 * 60 * 1000,
  format: "summary only"
})

// Прочитать результат позже без ожидания
agent_result({
  id: 1,
  runSeq: 1
})

// Продолжить диалог
agent_continue({
  id: 1,
  prompt: "Now fix them",
  phase: "implementation",
  runtimeBudgetMs: 0 // без дедлайна (значение по умолчанию)
})

// Список агентов
agent_list()

// Убить агента
/akill 1
```

### 3. Команды пользователя

- `/agents` — показать оверлей со статусами всех агентов
- `/aenter <id>` — открыть чат-оверлей с конкретным сабагентом
- `/akill <id>` — убить агента по ID
- `/acont <id> <prompt>` — продолжить завершённого агента из команды
- `/aclear` — скрыть виджеты завершённых/ошибочных агентов, не удаляя ID, результаты и историю. Работающие остаются видимыми; `/agents` и инструменты родителя видят всех. При продолжении виджет возвращается.

## 🏷️ Теги инструментов

| Тег | Инструменты |
|-----|-------------|
| `Bash` | read, grep, find, ls, glob, bash, script_run |
| `Web` | + web_fetch |
| `Wr` | + edit, write, apply_patch |
| `Agents` | + agent_spawn, agent_join, agent_result, agent_continue, agent_list |
| `Task` | + task (одноразовый саб-агент) |
| `UI` | + ask_user, todo |

Базовые инструменты (`read`, `grep`, `find`, `ls`, `glob`) включены всегда.

## 🔧 Использование в своём расширении

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawnPiProcess, makeSessionFile } from "../base/agent-runner.ts";
import { parseAgentEvent } from "../base/agent-events.ts";
import { resolveTagsToTools } from "../base/agent-tags.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "my_spawn",
    async execute(callId, args, signal, onUpdate, ctx) {
      // 1. Создать файл сессии
      const sessionFile = makeSessionFile(id, ctx.cwd, "my-agents");
      
      // 2. Резолв тегов в инструменты
      const tools = resolveTagsToTools("Bash,Web");
      
      // 3. Запустить процесс
      const proc = spawnPiProcess({
        task: args.task,
        sessionFile,
        toolList: tools,
        extensions: [],
        model: ctx.model?.id,
        cwd: ctx.cwd,
      });
      
      // 4. Парсить события
      proc.stdout?.on("data", (chunk) => {
        // ...parse lines...
        const event = JSON.parse(line);
        parseAgentEvent(event, mutableState);
      });
    }
  });
}
```

См. полный пример в `extensions/examples/agent-team.ts`.

## ⚙️ Конфигурация

### Дополнительные возможности orchestrator

- `phase="research|implementation|verification"` — фазовая рамка для sub-agent workflow
- `mode="fork" context="recent"` — передать дочернему агенту компактный recent context родительской сессии
- `contextTurns` / `contextMaxChars` — ограничить объём inherited recent context
- `notify="off|ui|turn"` — настроить способ уведомления о завершении сабагента
- `artifact=true` — сохранить полный output в файл и вернуть путь
- `agent_result` — прочитать completion result завершённого агента без ожидания

### Время выполнения, continuation и cleanup

- `agent_join` и `agent_wait_*` ждут до 20 минут по умолчанию; `timeoutMs` меняет только терпение ожидания. По timeout агент продолжает работать и сохраняет обычный статус.
- Запуск и продолжение не имеют дедлайна по умолчанию (`runtimeBudgetMs: 0`). Явное целое значение в миллисекундах задаёт бюджет для `agent_spawn` / `agent_continue`; пропуск в continuation наследует текущие `0` или предыдущий бюджет, а `0` снимает лимит.
- По исчерпании бюджета агент останавливается с частичным результатом и диагностикой. Продолжить можно явно в живой runtime-сессии после проверки файлов и уже совершённых side effects; автоматических повторов нет.
- `notify="ui"` (по умолчанию) — уведомление в интерфейсе; `notify="turn"` также включает follow-up родителя; `notify="off"` отключает оба. Ошибки запуска уведомляют так же, как завершение. Ручная остановка и `session_shutdown` всё равно завершают процесс.
- Completion-файл сохраняет `interruptionReason` (`runtime_budget`, `user_kill`, `parent_shutdown`), `runtimeBudgetMs` и `lastActivityAt`. Последнее — время наблюдаемого события, не доказательство полезного прогресса.
- При продолжении итог берётся только из событий нового процесса: общая история остаётся контекстом модели, но старый текст не подставляется вместо нового ответа. Если текущий ответ не получен, возвращается явная диагностика; история доступна через `/aenter`.
- При shutdown неуспешные/прерванные логи и completion-файлы сохраняются, но не загружаются автоматически в следующую runtime-сессию. Успешные принадлежащие агентам логи очищаются; широкого удаления каталогов нет.

### .pi/model-tiers.json

```json
{
  "high": "openrouter/anthropic/claude-sonnet-4",
  "medium": "openrouter/google/gemini-3-flash-preview",
  "low": "openrouter/google/gemini-3-flash-preview"
}
```

Tier одновременно определяет уровень thinking дочернего Pi-процесса:

- `low` → `--thinking high`
- `medium` → `--thinking xhigh`
- `high` → `--thinking high`
- tier не указан → модель родителя и `--thinking off`

При независимых задачах предпочитайте `agent_wait_any(join:true)`: обрабатывайте готовые результаты и запускайте зависимые этапы по мере готовности. `agent_wait_all` нужен для общего интеграционного барьера. Ограниченные исправления возвращайте через `agent_continue` исполнителю с полезным контекстом; новый агент нужен для независимого review или другой специализации.

Размер делегации тоже важен: один большой агент несёт лишний контекст и может смешать независимые результаты; множество крошечных агентов добавляют координацию и дублируют контекст. Предпочитайте bounded tasks с отдельно проверяемым результатом; число работников выбирайте по независимости задач, зависимости выполняйте последовательно, общие файлы отдавайте одному владельцу, тяжёлые проверки не запускайте одновременно. Родитель интегрирует результаты, проверяет diff и верификацию.

Выбирайте минимальный достаточный tier. `low` подходит не только для механики, но и для широкого reconnaissance с чётким вопросом. `medium` — основной уровень почти для всей нетривиальной делегации, включая анализ архитектуры, debugging, review и подготовку рекомендаций. Финальные важные решения принимает родительская модель.

`high` — исключительная эскалация: узкая особо сложная подзадача после неудачи medium, непримиримые выводы нескольких medium-агентов или независимая проверка критичного security/data-инварианта. Архитектура, неоднозначность, много модулей и высокая цена ошибки сами по себе не являются основанием для high.

Code review, architecture review, final-pipeline review, верификация и read-only аудиты — это территория `medium`: сабагенты уровня medium собирают замечания по областям, родительская модель сводит их и выносит финальное суждение. Широкая задача (прочитать много файлов, ревью ветки) — сигнал к декомпозиции или к medium, но никогда не к high.

### .pi/agents/*.md

```markdown
---
name: scout
description: Explores codebase structure
tools: read,grep,find,ls
---

You are a scout agent. Explore and report.
```

## 📊 Примеры расширений

| Файл | Описание |
|------|----------|
| `examples/agent-team.ts` | Диспетчер с командами агентов |
| `examples/agent-chain.ts` | Последовательный pipeline |
| `examples/subagent-widget.ts` | Виджеты саб-агентов с /sub командами |

## 🔗 Зависимости

- `@mariozechner/pi-coding-agent` — API расширений
- `@mariozechner/pi-tui` — UI компоненты
- `@sinclair/typebox` — Валидация схем

## 📝 Константы

```typescript
// agent-runner.ts
AGENT_JOIN_TIMEOUT_MS = 20 * 60 * 1000  // 20 минут
WIDGET_UPDATE_INTERVAL_MS = 1000         // 1 сек
SIGKILL_DELAY_MS = 3000                  // 3 сек до SIGKILL
```

## 🐛 Отладка

Включить подробный вывод:
```bash
DEBUG=pi:agent pi -e extensions/base/base-agents.ts
```

Просмотр сессии агента:
```bash
cat .pi/agent-sessions/subagents/agent-1-*.jsonl
```
