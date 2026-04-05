# Тесты для Base Agents

## Структура тестов

| Файл | Тип | Описание |
|------|-----|----------|
| `base-agents-tests.md` | Спецификация | Основной ручной/regression план тестирования с чек-листами |
| `base-agents-quick-test.md` | Smoke | Быстрые сценарии для ручной проверки основных flows |

На текущий момент в репозитории **нет** отдельных файлов `base-agents.unit.test.ts` и `base-agents.integration.test.ts`.
Если они появятся позже, этот документ можно расширить реальными командами запуска.

## Запуск тестов

### Ручное тестирование

```bash
# Запустить base-agents
pi -e extensions/base/base-agents.ts

# В интерактивном режиме выполнить:
agent_spawn tags="Bash" task="echo hello" name="test-agent"
agent_list
agent_join id=1
agent_result id=1
```

### Проверка runtime reload guards

```bash
python scripts/check-runtime-reload-guards.py
```

## Покрытие модулей

### ✅ agent-tags.ts
- [x] `resolveTagsToTools()` — все теги и комбинации
- [x] `toolsNeedBaseTools()` — проверка зависимостей
- [x] `toolsNeedBaseAgents()` — проверка зависимостей
- [x] `getBuiltinTools()` — фильтрация инструментов

### ✅ agent-events.ts
- [x] `parseAgentEvent()` — все типы событий
- [x] `extractTerminalResult()` — извлечение результатов
- [x] `extractTerminalResultFromFile()` — чтение из файла
- [x] `parseSessionFile()` — парсинг JSONL
- [x] `getTextFromContent()` — извлечение текста
- [x] `getElapsedTime()` — форматирование времени

### ✅ model-tiers.ts
- [x] `loadModelTiers()` — загрузка конфигурации
- [x] `resolveModel()` — резолв модели по tier
- [x] `reverseLookupTier()` — обратный поиск
- [x] `currentModelString()` — форматирование модели
- [x] `modelLabel()` — короткое имя модели

### ✅ agent-runner.ts
- [x] `canonicalizeToolList()` — канонизация списка
- [x] `resolveToolsParam()` — резолв параметров
- [x] `makeSessionFile()` — создание файла сессии
- [x] `cleanSessionDir()` — очистка директории
- [x] Константы таймаутов

### 🔄 base-agents.ts (интеграция)
- [x] Регистрация инструментов
- [x] Регистрация команд
- [x] Обработчики событий
- [x] Жизненный цикл агента
- [x] Управление сессиями

## Добавление новых тестов

### Unit тест

```typescript
import { describe, it, expect } from "bun:test";
import { myFunction } from "../extensions/base/my-module.ts";

describe("my-module.ts", () => {
  describe("myFunction()", () => {
    it("does something expected", () => {
      const result = myFunction("input");
      expect(result).toBe("expected output");
    });
  });
});
```

### Интеграционный тест

```typescript
it("tests full agent lifecycle", async () => {
  // Setup
  const extension = await import("../extensions/base/base-agents.ts");
  extension.default(mockPi);
  
  // Execute
  const result = await tools.get("agent_spawn").execute(
    "call-id",
    { tags: "Bash", task: "echo test" },
    undefined,
    undefined,
    mockCtx
  );
  
  // Assert
  expect(result.details.id).toBeDefined();
});
```

## CI/CD интеграция

Пока для `base-agents` в репозитории актуальны в первую очередь:
- ручные smoke/regression сценарии из `base-agents-quick-test.md`
- расширенный чек-лист из `base-agents-tests.md`
- проверка `python scripts/check-runtime-reload-guards.py`

Если в проект позже будут добавлены реальные unit/integration tests, сюда стоит вернуть конкретные CI-команды.

## Отладка

```bash
# С отладочным выводом Pi
DEBUG=pi:agent pi -e extensions/base/base-agents.ts
```
