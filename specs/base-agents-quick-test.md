# Быстрый тест Base Agents

## Запуск

```bash
pi -e extensions/base/base-agents.ts
```

## Базовые сценарии

### 1. Создание и ожидание агента
```
agent_spawn tags="Bash" task="echo 'Hello from agent!'" name="greeter"
agent_list
agent_join id=1
```

**Ожидаемый результат:**
- ID присвоен (начинается с 1)
- Статус: running → done
- Output: "Hello from agent!"
- Время выполнения показано

### 2. Параллельные агенты
```
agent_spawn tags="Bash" task="sleep 2 && echo 'First'" name="slow1"
agent_spawn tags="Bash" task="sleep 1 && echo 'Second'" name="slow2"
agent_list
```

**Ожидаемый результат:**
- Два агента в списке
- Оба в статусе running
- Разные ID (1 и 2)

### 3. Теги инструментов
```
agent_spawn tags="Web" task="Fetch https://example.com" name="fetcher"
agent_spawn tags="Wr" task="List files in current dir" name="lister"
agent_list
```

**Ожидаемый результат:**
- Агенты создаются с разными наборами инструментов
- Web: доступен web_fetch
- Wr: доступны edit, write

### 4. Продолжение диалога
```
agent_spawn tags="Bash" task="pwd" name="navigator"
agent_join id=1
agent_continue id=1 prompt="Now list files here"
agent_join id=1
agent_result id=1 runSeq=2
```

**Ожидаемый результат:**
- История сохранена
- turnCount > 1
- Новый ответ содержит список файлов

**Примечание:**
- Этот сценарий надёжен в рамках живой runtime-сессии Pi.
- В отдельных headless / print-mode запусках continuation может не сработать, если session files уже очищены при `session_shutdown`.

### 5. Обработка ошибок
```
agent_spawn tags="Bash" task="exit 1" name="failer"
agent_join id=1
```

**Ожидаемый результат:**
- Статус: error
- exitCode: 1
- Виджет показывает ✗

### 6. Управление через команды
```
# Создать несколько агентов
agent_spawn tags="Bash" task="sleep 10" name="long1"
agent_spawn tags="Bash" task="sleep 10" name="long2"

# Показать виджет
/agents

# Убить одного
/akill 1

# Проверить
agent_list

# Очистить всех
/aclear
```

### 7. Completion result без ожидания
```
agent_spawn tags="Bash" task="echo 'ready'" name="result-reader"
agent_join id=1
agent_result id=1
```

**Ожидаемый результат:**
- `agent_result` возвращает completion envelope данные без нового ожидания
- Видны status / runSeq / outcome

### 8. Phase workflow
```
agent_spawn tags="Bash" task="Inspect the code and report findings" phase="research" name="phased"
agent_join id=1
agent_continue id=1 prompt="Implement the selected approach" phase="implementation"
agent_join id=1
agent_continue id=1 prompt="Verify the result and list risks" phase="verification"
agent_join id=1
```

**Ожидаемый результат:**
- Фаза видна в ответах `agent_spawn` / `agent_continue`
- Нетипичный переход фазы даёт warning, но не ломает workflow

### 9. Fork context
```
# Сначала обсудить задачу с главным агентом
agent_spawn tags="Bash" task="Summarize the recent discussion" mode="fork" context="recent" contextTurns=4 contextMaxChars=4000 name="forked"
agent_join id=1
```

**Ожидаемый результат:**
- Sub-agent видит recent parent context
- В ответе spawn видно `Spawn mode: fork (recent)`

### 10. Fork downgrade-case
```
agent_spawn tags="Bash" task="Summarize the recent discussion" mode="fork" name="forked-fallback"
```

**Ожидаемый результат:**
- Возвращается warning про downgrade до fresh mode

### 11. Wait-инструменты
```
agent_spawn tags="Bash" task="sleep 2 && echo 'First'" name="slow1"
agent_spawn tags="Bash" task="sleep 1 && echo 'Second'" name="slow2"
agent_wait_any ids=[1,2] join=true
agent_wait_all ids=[1,2] join=true
```

**Ожидаемый результат:**
- `agent_wait_any` возвращает первый завершившийся результат inline
- `agent_wait_all` возвращает все результаты inline

## Проверка файлов

```bash
# Сессии агентов
ls -la .pi/agent-sessions/

# Содержимое сессии
cat .pi/agent-sessions/subagents/agent-1-*.jsonl
```

## Отладка

```bash
# С подробным выводом
DEBUG=pi:agent pi -e extensions/base/base-agents.ts

# Только агенты без других расширений
pi -e extensions/base/base-agents.ts --no-extensions
```

## Ожидаемые файлы

```
.pi/
├── agent-sessions/
│   └── subagents/
│       ├── agent-1-<timestamp>.jsonl
│       ├── agent-2-<timestamp>.jsonl
│       └── ...
└── agents/
    └── example-scout.md
```

## Чек-лист работоспособности

- [ ] `agent_spawn` создаёт агента и возвращает ID
- [ ] `agent_list` показывает всех агентов со статусами
- [ ] `agent_join` блокирует до завершения
- [ ] `agent_continue` продолжает существующего агента
- [ ] `/akill` завершает работающего агента
- [ ] `/agents` показывает виджет
- [ ] `/akill` убивает по ID
- [ ] `/aclear` очищает завершённых
- [ ] Сессии сохраняются в `.pi/agent-sessions/`
- [ ] Теги корректно разрешаются в инструменты
