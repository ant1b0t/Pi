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

// Дождаться завершения
agent_join({
  id: 1,
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
  phase: "implementation"
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
- `/aclear` — очистить завершённые агенты из UI

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

### Ограничение continuation и cleanup

- `agent_continue` надёжно поддерживается в рамках живой runtime-сессии Pi.
- При `session_shutdown` файлы sub-agent session могут очищаться автоматически.
- Поэтому continuation между отдельными headless / print-mode запусками не следует считать гарантированным сценарием, если отдельно не введена политика долгого хранения session files.

### .pi/model-tiers.json

```json
{
  "high": "openrouter/anthropic/claude-sonnet-4",
  "medium": "openrouter/google/gemini-3-flash-preview",
  "low": "openrouter/google/gemini-3-flash-preview"
}
```

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
AGENT_JOIN_TIMEOUT_MS = 15 * 60 * 1000  // 15 минут
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
