# Kimi Provider Extension

Расширенный провайдер для интеграции Moonshot AI (Kimi) с Pi Coding Agent.

## Возможности

### 1. Поддерживаемые модели

| Модель | Контекст | Reasoning | Vision | Стоимость (input/output) |
|--------|----------|-----------|--------|-------------------------|
| `moonshot-v1-8k` | 8K | ❌ | ❌ | $0.3 / $1.2 |
| `moonshot-v1-32k` | 32K | ❌ | ❌ | $0.6 / $2.4 |
| `moonshot-v1-128k` | 128K | ❌ | ❌ | $1.2 / $4.8 |
| `kimi-k2-32k` | 32K | ✅ | ❌ | $0.6 / $2.4 |
| `kimi-k2-128k` | 128K | ✅ | ❌ | $1.2 / $4.8 |
| `kimi-k2.5` | 256K | ✅ | ✅ | $0.6 / $3.0 |

### 2. File API интеграция

Автоматическая загрузка больших файлов через Moonshot File API:

- **Порог**: файлы >50KB (~12.5K токенов) автоматически загружаются
- **Поддерживаемые форматы**: PDF, DOC, TXT, CSV, код, изображения и др.
- **Лимиты**: до 100MB на файл, 1000 файлов на пользователя
- **Автоочистка**: файлы удаляются автоматически после использования

### 3. Auto-context routing

Автоматический выбор оптимальной модели на основе размера контекста:

```
< 4K токенов  → moonshot-v1-8k
< 16K токенов → moonshot-v1-32k / kimi-k2-32k
< 64K токенов → moonshot-v1-128k / kimi-k2-128k
> 64K токенов → kimi-k2.5
```

### 4. Reasoning mode (K2 series)

Модели K2 поддерживают thinking mode:

- **Thinking mode** (default): Показывает reasoning_content с ходом рассуждений
- **Instant mode**: Отключает reasoning для скорости (экономия 60-75% токенов)

### 5. Vision support (K2.5)

Kimi K2.5 поддерживает анализ изображений:

```typescript
// В сообщении можно передавать изображения
{
  role: "user",
  content: [
    { type: "text", text: "Describe this image" },
    { type: "image_url", image_url: { url: "data:image/png;base64,..." } }
  ]
}
```

## Использование

### Базовый запуск

```bash
# Стандартный режим
just ext-provider-kimi

# Reasoning mode с K2
just ext-provider-kimi-reasoning

# Vision mode с K2.5
just ext-provider-kimi-vision

# Полный режим с дополнительными инструментами
just ext-provider-kimi-full
```

### Инструменты

#### `kimi_upload`

Загрузка файла в File API для эффективной обработки:

```
/kimi_upload path=/path/to/file.pdf purpose=file-extract
```

#### `kimi_search`

Поиск в интернете (требуется webFetch или встроенный поиск K2.5):

```
/kimi_search query="latest TypeScript features" recency_days=7
```

#### `/kimi-cleanup`

Очистка загруженных файлов для освобождения места:

```
/kimi-cleanup
```

## Конфигурация

### Переменные окружения

```bash
# Обязательная
export MOONSHOT_API_KEY="sk-..."

# Опционально: выбор региона
export MOONSHOT_BASE_URL="https://api.moonshot.cn/v1"  # China (default)
# export MOONSHOT_BASE_URL="https://api.moonshot.ai/v1"  # Global
```

### Автоматическая настройка в `.env`

```bash
MOONSHOT_API_KEY=sk-your-key-here
```

## Сравнение с другими провайдерами

| Фича | Kimi | Claude | OpenAI |
|------|------|--------|--------|
| File API | ✅ Нативный | ❌ Нет | ❌ Нет |
| Reasoning | ✅ K2 series | ✅ Extended | ✅ o-series |
| Vision | ✅ K2.5 | ✅ All | ✅ GPT-4V |
| Context | ✅ До 256K | ✅ До 200K | ✅ До 128K |
| Cost | ✅ Низкая | 💰 Высокая | 💰 Средняя |
| Search | ✅ Встроенный | ❌ Нет | ✅ GPT-4o |

## Оптимизации

### 1. Экономия токенов с File API

```typescript
// Без File API (дорого для больших файлов)
const content = readFile("large.pdf"); // 100KB = ~25K токенов
// Стоимость: 25K * $0.6/1M = $0.015 за запрос

// С File API (экономия)
const fileId = await uploadFile("large.pdf");
// Стоимость: $0 + извлечение (один раз)
```

### 2. Выбор модели по задаче

| Задача | Рекомендуемая модель | Почему |
|--------|---------------------|--------|
| Быстрые ответы | moonshot-v1-8k | Скорость, низкая цена |
| Code review | kimi-k2-32k | Reasoning, умеренный контекст |
| Документация | kimi-k2.5 | 256K контекст, vision |
| Агентные задачи | kimi-k2-128k | Tool calling, reasoning |
| Математика | kimi-k2.5 Thinking | Лучшие бенчмарки (96.1% AIME) |

## Ограничения

1. **Rate limits**: Зависят от уровня аккаунта (RPM, TPM, TPD)
2. **File storage**: Максимум 1000 файлов, 10GB общий объём
3. **File retention**: Файлы хранятся до явного удаления
4. **Vision**: Только K2.5 поддерживает изображения

## Troubleshooting

### "File upload failed"

- Проверьте размер файла (<100MB)
- Убедитесь в поддерживаемом формате
- Проверьте доступное место (лимит 10GB)

### "Model context exceeded"

- Используйте модель с большим контекстом
- Включите File API для больших файлов
- Очистите историю диалога

### "Rate limit exceeded"

- Уменьшите частоту запросов
- Используйте batch mode
- Обратитесь в Moonshot для увеличения лимитов

## Ссылки

- [Moonshot Platform Docs](https://platform.moonshot.cn/docs)
- [Kimi API Reference](https://platform.moonshot.cn/docs/api)
- [Pricing](https://platform.moonshot.cn/docs/pricing)
