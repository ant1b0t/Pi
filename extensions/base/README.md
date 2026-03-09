# Base Agents — Sub-Agent Orchestration for Pi

Модульная система саб-агентов для Pi Coding Agent. Позволяет создавать, управлять и оркестрировать фоновыми агентами с различными наборами инструментов.

## 📁 Структура

| Файл | Назначение | Экспорты |
|------|------------|----------|
| `base-agents.ts` | Основной файл с инструментами | `agent_spawn`, `agent_join`, `agent_list`, `agent_continue` |
| `agent-runner.ts` | Запуск процессов и сессии | `spawnPiProcess`, `makeSessionFile`, `resolveToolsParam` |
| `agent-events.ts` | Парсинг событий | `parseAgentEvent`, `extractTerminalResultFromFile` |
| `agent-tags.ts` | Теги → инструменты | `resolveTagsToTools`, `getBuiltinTools` |
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
  id: 1,                  // ID агента
  timeout: 300            // Таймаут в секундах
})

// Продолжить диалог
agent_continue({
  id: 1,
  prompt: "Now fix them"
})

// Список агентов
agent_list()

// Убить агента
agent_kill({ id: 1 })
```

### 3. Команды пользователя

- `/agents` — показать оверлей со статусами всех агентов
- `/akill <id>` — убить агента по ID
- `/aclear` — очистить завершённые агенты из UI

## 🏷️ Теги инструментов

| Тег | Инструменты |
|-----|-------------|
| `Bash` | read, grep, find, ls, glob, bash, script_run |
| `Web` | + web_fetch |
| `FS` | + edit, write, apply_patch |
| `Agents` | + agent_spawn, agent_join, agent_continue, agent_list |
| `Task` | + task (одноразовый саб-агент) |
| `UI` | + ask_user, todo |
| `All` | все инструменты |

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
        tools,
        model: ctx.model?.id,
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
AGENT_JOIN_POLL_INTERVAL_MS = 500        // 0.5 сек
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
