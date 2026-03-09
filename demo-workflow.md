# 🎬 Демо-воркфлоу: Работа с сабагентами

## Ситуация
Пользователь просит: "Добавь в проект возможность экспорта сессий в Markdown"

## Как работает главный агент (оркестратор):

### 1. Параллельный ресеч (agent_spawn × 3)
```
agent_spawn(
  tier="medium",
  tags="FS,Read",
  name="structure-explorer",
  task="Найди все файлы связанные с экспортом сессий. 
        Ищи: export*, session*, *.jsonl, *.md"
)

agent_spawn(
  tier="high", 
  tags="FS,Read",
  name="code-analyzer",
  task="Проанализируй как устроен текущий экспорт в HTML.
        Найди: какие форматы поддерживаются, 
        где логика сериализации сессий"
)

agent_spawn(
  tier="low",
  tags="Web",
  name="md-format-researcher", 
  task="Найди лучшие практики для экспорта чатов в Markdown.
        Какие есть стандартные форматы?"
)
```

### 2. Ожидание результатов
```
agent_wait_all()
// Блокируемся пока все 3 агента не закончат
```

### 3. Сбор результатов
```
agent_join(id=1)  // structure-explorer
// → Список релевантных файлов

agent_join(id=2)  // code-analyzer  
// → Анализ текущей архитектуры экспорта

agent_join(id=3)  // md-format-researcher
// → Рекомендации по формату Markdown
```

### 4. Параллельная реализация
```
agent_spawn(
  tier="high",
  tags="FS,Edit,Write",
  name="md-exporter-dev",
  task="Напиши функцию exportToMarkdown() на основе 
        анализа exportToHTML(). Сохрани в src/export/md.ts"
)

agent_spawn(
  tier="medium",
  tags="FS,Edit,Write", 
  name="test-writer",
  task="Напиши тесты для exportToMarkdown(). 
        Используй существующие тесты экспорта как пример"
)

agent_wait_all()
```

### 5. Финализация
```
agent_join(id=4)  // md-exporter-dev
agent_join(id=5)  // test-writer

// Главный агент синтезирует финальный ответ:
// "Готово! Добавлена фича экспорта в Markdown:
// - Код: src/export/md.ts
// - Тесты: tests/export/md.test.ts
// - Использование: pi --export-md session.jsonl"
```

---

## 🎮 Интерактивное управление (TUI)

В процессе пользователь может:

```
/agents                    # Посмотреть всех агентов
›  #1 structure-explorer  ✓ done (12s)
   #2 code-analyzer       ▶ running (45s) · analyzing src/export/
   #3 md-format-researcher ✓ done (8s)

/aenter 2                  # Войти в чат с code-analyzer
> Ты уверен что правильно понял формат JSONL?
> Давай ещё раз проверь структуру messages

/acont 2 "Перепроверь структуру messages в session.jsonl"

/akill 2                   # Если агент завис

/aclear                    # Убрать завершённых из списка
```

---

## 💡 Ключевые преимущества

1. **Параллелизм** — 3 задачи делаются одновременно, не последовательно
2. **Изоляция контекста** — сабагенты не засоряют контекст главного агента
3. **Интерактивность** — можно вмешаться в работу любого агента
4. **Экономия** — простые задачи на дешёвых моделях (low tier)
5. **Надёжность** — если один агент упал, остальные продолжают работать
