# Тесты для Base Agents

## Структура тестов

| Файл | Тип | Описание |
|------|-----|----------|
| `base-agents-tests.md` | Спецификация | Ручной план тестирования с чек-листами |
| `base-agents.unit.test.ts` | Unit тесты | Автоматические тесты для отдельных модулей |
| `base-agents.integration.test.ts` | Интеграционные | Тесты всего расширения с моками Pi API |

## Запуск тестов

### Unit тесты

```bash
# Запуск всех unit-тестов
bun test specs/base-agents.unit.test.ts

# С подробным выводом
bun test specs/base-agents.unit.test.ts --verbose
```

### Интеграционные тесты

```bash
# Запуск интеграционных тестов
bun test specs/base-agents.integration.test.ts
```

### Ручное тестирование

```bash
# Запустить base-agents
pi -e extensions/base/base-agents.ts

# В интерактивном режиме выполнить:
agent_spawn tags="Bash" task="echo hello" name="test-agent"
agent_list
agent_join id=1 timeout=30
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

```yaml
# .github/workflows/test.yml
name: Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun test specs/base-agents.unit.test.ts
      - run: bun test specs/base-agents.integration.test.ts
```

## Отладка тестов

```bash
# С отладочным выводом
DEBUG=bun:test bun test specs/base-agents.unit.test.ts

# Только один describe
bun test --grep "agent-tags.ts"

# Только один test
bun test --grep "returns BASE_TOOLS for empty string"
```
