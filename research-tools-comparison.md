# Сравнительный анализ Tools: Claude Code vs OpenCode vs OpenClaw → Pi

## 1. Текущие инструменты Pi

Pi по умолчанию предоставляет **4 основных** + **3 дополнительных** built-in tools:

| Tool | Описание | По умолч. |
|------|----------|-----------|
| `read` | Чтение файлов (текст + изображения), offset/limit для больших файлов | ✅ |
| `write` | Создание/перезапись файлов | ✅ |
| `edit` | Точечная замена текста (find & replace) | ✅ |
| `bash` | Выполнение shell-команд | ✅ |
| `grep` | Поиск по содержимому (через `--tools grep`) | ❌ |
| `find` | Поиск файлов (через `--tools find`) | ❌ |
| `ls` | Листинг директорий (через `--tools ls`) | ❌ |

Расширяется через **Extensions** (TypeScript), **Skills** (SKILL.md), **Pi Packages**.

---

## 2. Инструменты Claude Code (15 tools)

| Tool | Описание | Permission | Есть в Pi? |
|------|----------|------------|------------|
| `Bash` | Shell-команды | Yes | ✅ `bash` |
| `Read` | Чтение файлов | No | ✅ `read` |
| `Write` | Создание файлов | Yes | ✅ `write` |
| `Edit` | Точечная замена текста | Yes | ✅ `edit` |
| **`MultiEdit`** | Множественные правки в одном файле атомарно | Yes | ❌ |
| `Glob` | Поиск файлов по паттерну | No | ⚠️ `find` (не по умолч.) |
| `Grep` | Поиск по содержимому (ripgrep) | No | ⚠️ `grep` (не по умолч.) |
| `LS` | Листинг директорий | No | ⚠️ `ls` (не по умолч.) |
| **`WebFetch`** | Загрузка URL → обработка через Haiku → краткий ответ | Yes | ❌ |
| **`WebSearch`** | Веб-поиск (возвращает links+titles) | Yes | ❌ |
| **`TodoWrite`** | Создание/управление списком задач с приоритетами | No | ❌ |
| **`TodoRead`** | Чтение текущего TODO-списка | No | ❌ |
| **`Task`** | Запуск суб-агента для сложных задач | No | ❌ |
| **`NotebookRead`** | Чтение Jupyter notebooks | No | ❌ |
| **`NotebookEdit`** | Редактирование Jupyter notebook-ячеек | Yes | ❌ |
| `ExitPlanMode` | Выход из режима планирования | No | N/A |
| `BashOutput` | Получение вывода фоновых процессов | No | ❌ |
| `KillShell` | Убийство фоновых процессов | No | ❌ |

---

## 3. Инструменты OpenCode (12+ tools)

| Tool | Описание | Есть в Pi? |
|------|----------|------------|
| `bash` | Shell-команды | ✅ |
| `read` | Чтение файлов | ✅ |
| `write` | Создание файлов | ✅ |
| `edit` | Точечная замена | ✅ |
| `grep` | Поиск по содержимому | ⚠️ (не по умолч.) |
| `glob` | Поиск файлов по паттерну | ⚠️ (`find`) |
| `ls` | Листинг директорий | ⚠️ (не по умолч.) |
| **`fetch`** | Загрузка URL (format: markdown/text/html) | ❌ |
| **`sourcegraph`** | Поиск кода в публичных репозиториях | ❌ |
| **`agent`** | Запуск суб-задач через AI-агента | ❌ |
| **`todoread`** | Чтение TODO-списка | ❌ |
| **`todowrite`** | Управление TODO-списком | ❌ |
| **`webfetch`** | Загрузка веб-контента | ❌ |
| **`websearch`** | Веб-поиск через Exa AI | ❌ |
| **`question`** | Задать вопрос пользователю во время выполнения | ❌ |
| Custom tools | TypeScript/JS plugins в `.opencode/tools/` | ✅ (через extensions) |

---

## 4. OpenClaw — Экосистема (другой тип агента)

OpenClaw — это **не coding agent**, а **personal AI assistant** (hub-and-spoke архитектура для мессенджеров). Но его экосистема расширений интересна:

### Архитектура расширений
| Тип | Описание | Аналог в Pi |
|-----|----------|-------------|
| **Skills** | SKILL.md + скрипты, 2800+ в ClawHub | ✅ Skills (Agent Skills стандарт) |
| **Plugins** | TypeScript модули, runtime-расширения Gateway | ✅ Extensions |
| **Webhooks** | HTTP endpoints от внешних систем | ❌ (можно через extension) |

### Интересные идеи из OpenClaw
- **ClawHub** — маркетплейс skills (аналог Pi Packages, но с 2800+ skill)
- **memU** — долгосрочная память агента (низкий расход токенов)
- **Lobster** — workflow shell для композиции skills в pipeline
- **Self-improving agent** — агент пишет себе новые skills
- **Voice Call plugin** — голосовые звонки через Twilio
- **Multi-channel** — один агент, много интерфейсов (WhatsApp, Telegram, etc.)

---

## 5. Анализ: Самые полезные tools для добавления в Pi

### 🏆 Tier 1 — Высочайший приоритет (используются постоянно)

#### 1. `MultiEdit` — Атомарные множественные правки
**Источник:** Claude Code  
**Почему важно:** Текущий `edit` в Pi делает одну замену за раз. При рефакторинге файла с 5-10 изменениями это 5-10 отдельных tool calls, что:
- Тратит токены на повторные вызовы
- Медленнее (каждый вызов = round-trip)
- Рискованнее (промежуточные состояния файла могут быть невалидными)

**Реализация:** Extension с массивом `{oldText, newText}[]` для одного файла, применяемые атомарно.

```typescript
pi.registerTool({
  name: "multi_edit",
  description: "Make multiple edits to a single file atomically",
  parameters: {
    path: Type.String(),
    edits: Type.Array(Type.Object({
      oldText: Type.String(),
      newText: Type.String(),
      replaceAll: Type.Optional(Type.Boolean())
    }))
  },
  execute: async ({ path, edits }) => { /* ... */ }
});
```

#### 2. `WebFetch` — Загрузка и анализ веб-страниц
**Источник:** Claude Code + OpenCode  
**Почему важно:** Агент часто нужно:
- Проверить документацию API
- Прочитать README на GitHub  
- Проверить changelog библиотеки
- Исследовать Stack Overflow решения

Claude Code делает это элегантно: URL → fetch HTML → конвертация в Markdown → обработка быстрой моделью (Haiku) → краткий ответ. Это экономит контекст главной модели.

**Реализация:** Extension + можно использовать fast model для суммаризации.

#### 3. `TodoWrite` / `TodoRead` — Управление задачами
**Источник:** Claude Code + OpenCode  
**Почему важно:** Это **самая новаторская фича Claude Code**. TODO помогает LLM:
- Структурировать сложные задачи перед выполнением
- Отслеживать прогресс (pending → in_progress → completed)
- Не терять контекст в длинных сессиях
- Давать пользователю видимость прогресса

Anthropic в system prompt буквально пишет: *"Use TodoWrite VERY frequently"*

**Реализация:** Extension с UI-виджетом для отображения списка задач.

```typescript
interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
  id: string;
}
```

---

### 🥈 Tier 2 — Высокий приоритет (значительно улучшают workflow)

#### 4. `WebSearch` — Веб-поиск
**Источник:** Claude Code + OpenCode  
**Почему важно:** Агент может искать актуальную информацию: новые API, обновления библиотек, решения багов. OpenCode использует Exa AI бесплатно. Claude Code использует server-side Anthropic search.

**Замечание:** Pi уже имеет research skill, но это не built-in tool, а навык, который агент должен сам загрузить. Встроенный tool был бы удобнее.

#### 5. `Question` / Structured Input — Вопрос пользователю
**Источник:** OpenCode  
**Почему важно:** Иногда агенту нужно уточнение:
- "Использовать ESM или CJS?"
- "Какой database driver предпочитаете?"
- "Подтвердите: удаляю 3 файла?"

Pi уже имеет extension API для диалогов (`showInput`, `showSelect`), но нет **встроенного tool**, который модель может вызвать. Это позволило бы LLM самому решать, когда спрашивать.

#### 6. `Task` / `Agent` — Суб-агент
**Источник:** Claude Code (`Task`) + OpenCode (`agent`)  
**Почему важно:** Делегирование подзадач отдельному агенту:
- Параллельный поиск по кодовой базе
- Исследование одного вопроса, не загромождая основной контекст
- Разделение сложных задач

**Замечание:** Pi сознательно не включает sub-agents по умолчанию (философия — "build your own"). Но это один из самых востребованных паттернов, и Extension для этого — отличный кандидат.

---

### 🥉 Tier 3 — Средний приоритет (полезно для специфических случаев)

#### 7. `NotebookRead` / `NotebookEdit` — Jupyter Notebooks
**Источник:** Claude Code  
**Почему важно:** Data science workflows. Raw `.ipynb` JSON огромен и нечитаем для LLM. Парсер делает его компактным.

**Аудитория:** Data scientists, ML-инженеры.

#### 8. `Sourcegraph` — Поиск кода в публичных репозиториях  
**Источник:** OpenCode  
**Почему важно:** Быстрый поиск примеров использования API, паттернов, реализаций в open-source. Когда агенту нужно понять, как другие используют конкретную функцию.

#### 9. `BashOutput` / `KillShell` — Управление фоновыми процессами
**Источник:** Claude Code  
**Почему важно:** Запуск dev-серверов, watch-режимов, длинных тестов. Возможность проверить вывод позже и убить процесс.

**Замечание:** Pi рекомендует tmux для этого, но встроенный инструмент был бы удобнее для простых случаев.

---

### 💡 Tier 4 — Идеи из экосистемы (не tools, а паттерны)

#### 10. **Long-term Memory** (из OpenClaw memU)
Персистентная память между сессиями. Pi имеет AGENTS.md, но это статичный файл. Динамическая память (предпочтения пользователя, частые паттерны) была бы мощным дополнением.

#### 11. **LSP Integration** (из OpenCode)
OpenCode автоматически загружает LSP для используемого языка. Это даёт агенту:
- Реальные ошибки компиляции
- Автодополнение  
- Go-to-definition
- Find references

Это позволило бы агенту находить ошибки **без запуска сборки**.

#### 12. **Self-improving Skills** (из OpenClaw)
Агент, который сам создаёт себе новые skills на основе повторяющихся задач. Потенциально реализуемо как Pi Extension.

---

## 6. Рекомендуемый план реализации

### Фаза 1: Quick Wins (Extensions)
Эти можно реализовать как standalone Pi Extensions:

1. **`multi_edit`** — Атомарный multi-edit tool
2. **`todo`** — TodoRead/TodoWrite + UI виджет
3. **`question`** — Structured question tool (использует pi.showSelect/showInput)
4. **`web_fetch`** — URL fetcher с markdown-конверсией

### Фаза 2: Research & Web (Extensions/Skills)
4. **`web_search`** — Обёртка вокруг существующего research skill как tool
5. **`sourcegraph`** — Поиск кода в публичных репо

### Фаза 3: Advanced (Extensions)
6. **`sub_agent`** / `task` — Sub-agent spawner
7. **`notebook`** — Jupyter notebook read/edit
8. **`background_bash`** — Фоновые процессы с output/kill

### Фаза 4: Ecosystem
9. **Dynamic memory** — Persistence между сессиями
10. **LSP integration** — Языковые серверы для диагностики

---

## 7. Сводная матрица

| Tool | Claude Code | OpenCode | OpenClaw | Pi (текущий) | Рекомендация |
|------|:-----------:|:--------:|:--------:|:------------:|:------------:|
| bash | ✅ | ✅ | ✅ | ✅ | — |
| read | ✅ | ✅ | — | ✅ | — |
| write | ✅ | ✅ | — | ✅ | — |
| edit | ✅ | ✅ | — | ✅ | — |
| **multi_edit** | ✅ | ❌ | — | ❌ | 🏆 **Tier 1** |
| glob/find | ✅ | ✅ | — | ⚠️ opt-in | — |
| grep | ✅ | ✅ | — | ⚠️ opt-in | — |
| ls | ✅ | ✅ | — | ⚠️ opt-in | — |
| **web_fetch** | ✅ | ✅ | ✅ | ❌ | 🏆 **Tier 1** |
| **web_search** | ✅ | ✅ | ✅ | ⚠️ skill | 🥈 **Tier 2** |
| **todo_write** | ✅ | ✅ | — | ❌ | 🏆 **Tier 1** |
| **todo_read** | ✅ | ✅ | — | ❌ | 🏆 **Tier 1** |
| **task/agent** | ✅ | ✅ | ✅ | ❌ | 🥈 **Tier 2** |
| **question** | ❌ | ✅ | ✅ | ❌ | 🥈 **Tier 2** |
| notebook_r/w | ✅ | ❌ | — | ❌ | 🥉 Tier 3 |
| **sourcegraph** | ❌ | ✅ | — | ❌ | 🥉 Tier 3 |
| bg_bash | ✅ | ❌ | — | ❌ | 🥉 Tier 3 |
| **LSP** | ❌ | ✅ | — | ❌ | 💡 Tier 4 |
| **memory** | ❌ | ❌ | ✅ | ❌ | 💡 Tier 4 |
| skills marketplace | — | — | ✅ (2800+) | ✅ Pi Packages | — |
| custom tools | ✅ hooks | ✅ `.opencode/tools/` | ✅ plugins | ✅ extensions | — |
| MCP | ✅ | ✅ | ✅ | ⚠️ via ext | — |

---

## 8. Вывод

**Pi уже имеет отличную базу** (read/write/edit/bash + мощная extension system), но ему не хватает **6 ключевых tools**, которые есть у обоих основных конкурентов:

1. **MultiEdit** — единственная фича, которой нет ни у кого кроме Claude Code. Огромная экономия токенов.
2. **TodoWrite/TodoRead** — доказано, что радикально улучшает планирование агента. Есть у Claude Code и OpenCode.
3. **WebFetch** — необходимо для работы с документацией. Есть у всех трёх.
4. **WebSearch** — актуальная информация. Есть у всех трёх.
5. **Task/Agent** — суб-агенты для параллелизма. Есть у Claude Code и OpenCode.
6. **Question** — структурированные вопросы пользователю. Уникально для OpenCode.

Все эти tools можно реализовать как **Pi Extensions**, что полностью соответствует философии Pi — расширяемость без изменения ядра.
