# Kimi For Coding Provider Extension

OpenCode-совместимый провайдер Kimi For Coding для Pi.

## Конфигурация

- Provider ID: `kimi-for-coding`
- Base URL для Pi: `https://api.kimi.com/coding`
- API: `anthropic-messages`
- Ключ: `KIMI_API_KEY`
- Alias модели: `kimi-for-coding` -> `k2p5`
- Обязательный заголовок: `User-Agent: KimiCLI/0.77`

## Переменные окружения

```bash
export KIMI_API_KEY="sk-..."

# optional
export KIMI_BASE_URL="https://api.kimi.com/coding"
```

## Запуск

```bash
just ext-provider-kimi
just ext-provider-kimi-vision
```

## Важно

Используйте ключ из:

- https://www.kimi.com/code/console

И положите его в `.env` как `KIMI_API_KEY`.
