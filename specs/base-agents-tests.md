# Тестирование base-agents

## Описание
План тестирования модульной системы саб-агентов `extensions/base/base-agents.ts` и связанных модулей.

## Модули для тестирования

- `base-agents.ts` — Основной модуль с инструментами
- `agent-runner.ts` — Запуск процессов и управление сессиями
- `agent-events.ts` — Парсинг событий
- `agent-tags.ts` — Разрешение тегов в инструменты
- `model-tiers.ts` — Управление уровнями моделей

---

## 1. Модуль `agent-tags.ts`

### 1.1 Функция `resolveTagsToTools()`
- [ ] `resolveTagsToTools("")` — Пустая строка возвращает BASE_TOOLS
- [ ] `resolveTagsToTools("Bash")` — Добавляет bash, script_run
- [ ] `resolveTagsToTools("Web")` — Добавляет web_fetch
- [ ] `resolveTagsToTools("FS")` — Добавляет edit, write, apply_patch
- [ ] `resolveTagsToTools("Agents")` — Добавляет agent_spawn, agent_join, agent_continue, agent_list
- [ ] `resolveTagsToTools("Task")` — Добавляет task
- [ ] `resolveTagsToTools("UI")` — Добавляет ask_user, todo
- [ ] `resolveTagsToTools("Wr,Web,Bash")` — Несколько тегов комбинируются
- [ ] `resolveTagsToTools("  Bash  ,  Web  ")` — Пробелы обрезаются
- [ ] `resolveTagsToTools("Unknown")` — Неизвестный тег игнорируется

### 1.2 Функция `toolsNeedBaseTools()`
- [ ] `toolsNeedBaseTools(["web_fetch"])` — Возвращает true
- [ ] `toolsNeedBaseTools(["todo"])` — Возвращает true
- [ ] `toolsNeedBaseTools(["read", "bash"])` — Возвращает false

### 1.3 Функция `toolsNeedBaseAgents()`
- [ ] `toolsNeedBaseAgents(["agent_spawn"])` — Возвращает true
- [ ] `toolsNeedBaseAgents(["agent_join"])` — Возвращает true
- [ ] `toolsNeedBaseAgents(["read", "bash"])` — Возвращает false

### 1.4 Функция `getBuiltinTools()`
- [ ] `getBuiltinTools(["read", "web_fetch", "agent_spawn"])` — Возвращает ["read"]
- [ ] Фильтрует только встроенные инструменты Pi

---

## 2. Модуль `agent-events.ts`

### 2.1 Функция `parseAgentEvent()`
- [ ] `message_update` с `text_delta` — Обновляет `currentStreamText`
- [ ] `message_end` — Финализирует текст, обновляет `turnCount`, очищает `currentStreamText`
- [ ] `tool_execution_start` — Устанавливает `lastTool`
- [ ] `agent_end` с `kind: "text"` — Обновляет `lastAssistantText`
- [ ] `agent_end` с `kind: "error"` — Обновляет `lastErrorMessage`
- [ ] Некорректный JSON — Не выбрасывает ошибку

### 2.2 Функция `extractTerminalResult()`
- [ ] Сообщение с текстом — Возвращает `kind: "text"`
- [ ] Сообщение с ошибкой — Возвращает `kind: "error"`
- [ ] Только tool calls — Возвращает `kind: "tool-only"`
- [ ] Пустой массив — Возвращает `kind: "empty"`

### 2.3 Функция `extractTerminalResultFromFile()`
- [ ] Существующий файл — Парсит и возвращает результат
- [ ] Несуществующий файл — Возвращает `kind: "empty"`
- [ ] Повреждённый JSON — Пропускает некорректные строки

### 2.4 Функция `parseSessionFile()`
- [ ] Валидный JSONL — Возвращает массив HistoryItem
- [ ] Несуществующий файл — Возвращает пустой массив
- [ ] Смешанный контент (user, assistant, tool) — Правильно различает роли

### 2.5 Функция `getTextFromContent()`
- [ ] Массив с text блоками — Объединяет все текстовые блоки
- [ ] Пустой массив — Возвращает пустую строку
- [ ] Блоки других типов — Игнорирует их

### 2.6 Функция `getElapsedTime()`
- [ ] < 60 секунд — Возвращает "Xs"
- [ ] >= 60 секунд — Возвращает "Xm Ys"

---

## 3. Модуль `model-tiers.ts`

### 3.1 Функция `loadModelTiers()`
- [ ] Существующий валидный `.pi/model-tiers.json` — Возвращает ModelTiers
- [ ] Несуществующий файл — Возвращает null
- [ ] Невалидный JSON — Возвращает null
- [ ] Отсутствуют обязательные поля — Возвращает null

### 3.2 Функция `resolveModel()`
- [ ] `model` передан явно — Использует его
- [ ] `tier: "high"` — Выбирает из tiers.high
- [ ] `tier: "medium"` — Выбирает из tiers.medium
- [ ] `tier: "low"` — Выбирает из tiers.low
- [ ] Массив моделей в tier — Round-robin выбор
- [ ] Отсутствующий tier — Использует fallback
- [ ] Всё отсутствует — Возвращает undefined

### 3.3 Функция `reverseLookupTier()`
- [ ] Модель из high tier — Возвращает "high"
- [ ] Модель из medium tier — Возвращает "medium"
- [ ] Модель из массива — Возвращает соответствующий tier
- [ ] Неизвестная модель — Возвращает undefined

### 3.4 Функция `currentModelString()`
- [ ] `provider + id` — Возвращает "provider/id"
- [ ] Только id — Возвращает id
- [ ] Пустой объект — Возвращает undefined
- [ ] Пробелы в значениях — Обрезает

### 3.5 Функция `modelLabel()`
- [ ] "anthropic/claude-sonnet" — Возвращает "claude-sonnet"
- [ ] Пустая строка — Возвращает "default"
- [ ] Без слэша — Возвращает как есть

---

## 4. Модуль `agent-runner.ts`

### 4.1 Функция `makeSessionFile()`
- [ ] Создаёт директорию `.pi/agent-sessions/<subdir>/`
- [ ] Файл создаётся с правильным именем
- [ ] Проверка path traversal — Блокирует выход за пределы проекта

### 4.2 Функция `resolveToolsParam()`
- [ ] `undefined` — Возвращает базовые + Bash инструменты
- [ ] `"Bash,Web"` — Разрешает теги и канонизирует
- [ ] Массив строк — Канонизирует список

### 4.3 Функция `canonicalizeToolList()`
- [ ] Удаляет дубликаты
- [ ] Сортирует алфавитно
- [ ] Обрезает пробелы

### 4.4 Функция `spawnPiProcess()`
- [ ] Возвращает ChildProcess с stdout/stderr
- [ ] Передаёт правильные аргументы pi
- [ ] Устанавливает SESSION_FILE env var

### 4.5 Функция `killProcess()`
- [ ] Unix — Отправляет SIGTERM, затем SIGKILL
- [ ] Windows — Использует taskkill
- [ ] Несуществующий процесс — Не выбрасывает ошибку

### 4.6 Функция `cleanSessionDir()`
- [ ] Удаляет файлы `.jsonl` в директории
- [ ] Не трогает другие файлы
- [ ] Несуществующая директория — Молча возвращается

---

## 5. Модуль `base-agents.ts`

### 5.1 Инструмент `agent_spawn`
- [ ] Создаёт агента с тегами — Возвращает ID
- [ ] Создаёт агента с именем — Имя отображается в списке
- [ ] Создаёт файл сессии — Файл существует в `.pi/agent-sessions/`
- [ ] Запускает процесс pi — Процесс виден в системе
- [ ] Некорректные теги — Использует базовые инструменты
- [ ] Пустая задача — Создаёт агента (задача может быть любой)

### 5.2 Инструмент `agent_join`
- [ ] Агент завершился успешно — Возвращает output, exitCode: 0
- [ ] Агент завершился с ошибкой — Возвращает output, exitCode: != 0
- [ ] Агент ещё работает — Блокирует до завершения
- [ ] Несуществующий ID — Возвращает ошибку
- [ ] Таймаут — Прерывает ожидание по таймауту
- [ ] Сигнал отмены — Прерывает ожидание

### 5.3 Инструмент `agent_list`
- [ ] Нет агентов — Возвращает пустой список
- [ ] Есть агенты — Возвращает ID, статус, имя, задачу
- [ ] Статус обновляется — running/done/error корректны

### 5.4 Инструмент `agent_continue`
- [ ] Продолжает завершённого агента — Возвращает success
- [ ] Агент не существует — Возвращает ошибку
- [ ] Агент ещё работает — Возвращает ошибку
- [ ] Сохраняет историю — Новый prompt добавляется к сессии

### 5.5 Инструмент `agent_kill`
- [ ] Убивает работающего агента — Процесс завершается
- [ ] Несуществующий ID — Возвращает ошибку
- [ ] Уже завершённый агент — Возвращает success (idempotent)

### 5.6 Команда `/agents`
- [ ] Показывает виджет со статусами — Виджет отображается
- [ ] Обновляется в реальном времени — Статус меняется

### 5.7 Команда `/akill <id>`
- [ ] Убивает агента по ID — Процесс завершается
- [ ] Некорректный ID — Показывает ошибку

### 5.8 Команда `/aclear`
- [ ] Удаляет завершённых агентов из UI — Виджеты пропадают
- [ ] Не трогает работающих — running агенты остаются

---

## 6. Интеграционные тесты

### 6.1 Полный цикл агента
```
1. agent_spawn(tags="Bash", task="echo hello")
2. agent_join(id=1)
3. Проверить: output содержит "hello"
```

### 6.2 Агент с ошибкой
```
1. agent_spawn(tags="Bash", task="exit 1")
2. agent_join(id=1)
3. Проверить: status === "error", exitCode !== 0
```

### 6.3 Несколько агентов параллельно
```
1. agent_spawn(task="sleep 1") — ID 1
2. agent_spawn(task="sleep 1") — ID 2
3. agent_list() — Оба в статусе running
4. agent_join(id=1) — Ждёт завершения
5. agent_join(id=2) — Ждёт завершения
```

### 6.4 Продолжение диалога
```
1. agent_spawn(tags="Bash", task="count files")
2. agent_join(id=1) — Получаем результат
3. agent_continue(id=1, prompt="now find largest")
4. agent_join(id=1) — Новый результат
5. Проверить: история сохранена, turnCount > 1
```

### 6.5 Теги инструментов
```
1. agent_spawn(tags="Web", task="fetch example.com")
2. Проверить: инструменты включают web_fetch
3. agent_spawn(tags="FS", task="edit file")
4. Проверить: инструменты включают edit, write
```

---

## 7. Тесты производительности

- [ ] Создание 10 агентов параллельно — Все создаются без ошибок
- [ ] 1000 вызовов agent_list — Ответ < 100ms
- [ ] Большой output (>10KB) — Корректно обрезается/truncates

---

## 8. Тесты безопасности

- [ ] Path traversal в имени сессии — Блокируется
- [ ] Очень длинная задача (>10KB) — Обрабатывается
- [ ] Спецсимволы в задаче — Экранируются
- [ ] Команда injection — Не выполняется

---

## Запуск тестов

### Ручное тестирование
```bash
# Запустить base-agents
pi -e extensions/base/base-agents.ts

# В интерактивном режиме:
agent_spawn tags="Bash" task="echo test"
agent_list
agent_join id=1
```

### Автоматические тесты (если реализованы)
```bash
bun test specs/base-agents.test.ts
```

---

## Результаты тестирования

### Дата: ___________

| Модуль | Тесты | Пройдено | Провалено | Статус |
|--------|-------|----------|-----------|--------|
| agent-tags.ts | 13 | __ | __ | ⬜ |
| agent-events.ts | 18 | __ | __ | ⬜ |
| model-tiers.ts | 14 | __ | __ | ⬜ |
| agent-runner.ts | 16 | __ | __ | ⬜ |
| base-agents.ts | 20 | __ | __ | ⬜ |
| Интеграция | 5 | __ | __ | ⬜ |

**Общий статус:** ⬜ Не начато / 🟡 В процессе / 🟢 Готово

**Заметки:**
```
_____________________________________________
_____________________________________________
_____________________________________________
```
