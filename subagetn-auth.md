Ниже — **оптимальный план для Pi**.
Он решает текущую проблему сабагентов и не загоняет систему в тупик с костылями вокруг `process.env`.

---

# Цель

Сделать так, чтобы **TUI, CLI, `--mode json`, сабагенты и будущие фоновые раннеры** использовали **один и тот же механизм авторизации**.
Не `OAuth для TUI` + `API key для CLI`, а **единый provider auth layer**. Это ближе к тому, как устроены OpenClaw и OpenCode: у них credentials хранятся централизованно, а не живут только в env конкретного процесса. ([OpenClaw][1])

---

# Целевая архитектура

## 1. Единый Auth Resolver

Сделать модуль, например:

```ts
resolveProviderAuth(input: {
  providerId: string
  model?: string
  agentId?: string
  sessionId?: string
  projectRoot?: string
  env?: NodeJS.ProcessEnv
}): ResolvedAuth
```

### Что он должен уметь

* читать auth из:

  1. explicit CLI flags
  2. `process.env`
  3. project `.env`
  4. `~/.pi/agent/auth.json`
  5. дефолтного provider/model config
* возвращать **нормализованный результат**, а не “просто строку ключа”

Пример:

```ts
type ResolvedAuth =
  | { type: "api_key"; providerId: string; apiKey: string; source: "env" | ".env" | "auth.json" | "config" }
  | { type: "oauth"; providerId: string; accessToken: string; refreshToken?: string; expiresAt?: string; source: "auth.json" }
  | { type: "custom"; providerId: string; headers: Record<string, string>; source: "auth.json" | "config" }
```

---

## 2. Один Provider Client Factory

Сделать второй слой:

```ts
createProviderClient(resolvedAuth: ResolvedAuth, providerConfig: ProviderConfig): ProviderClient
```

Он уже знает:

* как подставить `Authorization`
* когда обновлять OAuth token
* какие заголовки нужны конкретному провайдеру
* как работать с API key и OAuth одинаково прозрачно для вызывающего кода

**Ключевой принцип:**
`agent-runner.ts` и сабагенты **не знают**, откуда пришёл auth.
Они знают только: `client = createProviderClient(resolveProviderAuth(...))`.

---

## 3. Сабагенты получают не ключ, а контекст

При спавне сабагента передавать не `GEMINI_API_KEY`, а:

```ts
{
  parentSessionId,
  parentAgentId,
  requestedModel,
  requestedProvider,
  authContextRef
}
```

Где `authContextRef` — это либо:

* ссылка на parent session,
* либо `credentialRef`,
* либо просто `(agentId, providerId, profileId)`.

Тогда child process сам вызывает `resolveProviderAuth(...)` и поднимает те же credentials.

Это соответствует правильной модели.
Не “родитель экспортнул env”, а “оба execution path резолвят один и тот же auth source”.
Такой подход ближе к OpenClaw/OpenCode. ([opencode.ai][2])

---

# Этапы внедрения

## Этап 1. Быстрый фикс

Срок по объёму — небольшой.
Цель — быстро починить текущий сценарий.

### Что сделать

1. Вынести текущую auth-логику из TUI и CLI в общий модуль `resolveProviderAuth`.
2. В `pi --mode json` вместо чтения только `process.env.*`:

   * сначала пробовать env
   * потом `.env`
   * потом `~/.pi/agent/auth.json`
3. Для Gemini/OpenAI/Kimi вернуть нормализованный auth object.
4. Временно разрешить adapter-слой:

   * если downstream SDK ещё жёстко ждёт `API_KEY`, прокидывать ему значение из resolved auth.

### Что это даст

* сабагенты перестанут зависеть только от env
* OAuth из `auth.json` станет доступен в CLI path
* текущий UX не сломается

### Ограничение

Это ещё **переходный слой**.
Внутри могут остаться места, где auth всё ещё мапится обратно в env-формат.

---

## Этап 2. Унификация transport/client layer

Цель — убрать костыль “OAuth → поддельный API_KEY”.

### Что сделать

1. Все provider SDK/HTTP-клиенты перевести на работу через `ResolvedAuth`.
2. Убрать из `agent-runner.ts` логику вида:

   * `if provider === "gemini" ...`
   * `if provider === "openai" ...`
3. Вынести в provider adapters:

   * `applyAuthHeaders()`
   * `refreshIfNeeded()`
   * `validateResolvedAuth()`

### Результат

CLI и TUI будут реально использовать один auth pipeline.

---

## Этап 3. Наследование контекста для сабагентов

Цель — сделать subagent spawning предсказуемым.

### Что сделать

1. При запуске сабагента передавать:

   * `parentProvider`
   * `parentModel`
   * `authContextRef`
   * `fallbackPolicy`
2. Если у сабагента модель/провайдер не указаны:

   * он наследует provider/model родителя
3. Если указаны:

   * резолвятся их credentials отдельно
4. Добавить policy:

   * `inherit`
   * `require-explicit-auth`
   * `fallback-to-parent`
   * `deny-cross-provider-without-auth`

### Почему это важно

Сейчас у тебя смешаны два кейса:

* “сабагент должен использовать ту же модель”
* “сабагент хочет другой провайдер”

Это должны быть **разные режимы**, а не один неявный сценарий.

---

## Этап 4. Формализация auth storage

Цель — убрать хаос в `auth.json`.

### Что сделать

Перевести `~/.pi/agent/auth.json` к структуре профилей.

Пример:

```json
{
  "profiles": {
    "gemini:default": {
      "provider": "gemini",
      "type": "oauth",
      "accessToken": "...",
      "refreshToken": "...",
      "expiresAt": "2026-03-09T18:00:00Z"
    },
    "openai:default": {
      "provider": "openai",
      "type": "api_key",
      "apiKey": "sk-..."
    },
    "kimi:default": {
      "provider": "kimi",
      "type": "api_key",
      "apiKey": "..."
    }
  },
  "routing": {
    "defaultProvider": "kimi",
    "defaultModelByProvider": {
      "kimi": "kimi-k2",
      "gemini": "gemini-2.5-pro"
    },
    "profileOrder": {
      "gemini": ["gemini:default"],
      "openai": ["openai:default"],
      "kimi": ["kimi:default"]
    }
  }
}
```

Это близко к auth profile model у OpenClaw, где и OAuth, и API keys хранятся в одном persisted store. ([OpenClaw][1])

---

## Этап 5. Политика источников и приоритетов

Нужно жёстко определить precedence.

### Рекомендованный порядок

1. `--api-key`, `--provider-token`, `--auth-profile`
2. `process.env`
3. project `.env`
4. `auth.json` profile
5. global config defaults

### Важно

`auth.json` не должен бесконтрольно перекрывать явные настройки.
У OpenCode есть баг-класс, где stored auth конфликтует с explicit config. Тебе это повторять не нужно. ([opencode.ai][3])

---

# Что делать с текущими вариантами A/B/C

## A. Наследование модели родителя

Оставить как **fallback policy**, но не как основное решение.

### Где использовать

* если сабагент не запросил свой provider/model
* если задача purely operational
* если parent session уже валидна

### Где не использовать

* если сабагент явно просит другой provider
* если нужен отдельный billing/account scope
* если нужны иные permissions/limits

---

## B. Читать `auth.json` в `agent-runner.ts`

Сделать, но только как **этап 1**.

### Как правильно

Не “прочитай `auth.json` и выставь `GEMINI_API_KEY`”, а:

* `agent-runner.ts` вызывает `resolveProviderAuth`
* временный adapter уже мапит auth в старый SDK формат

Это критичная разница.
Так ты не зацементируешь плохую архитектуру.

---

## C. Требовать реальные API keys

Оставить как **операционный fallback**.

### Когда применять

* provider не поддерживает OAuth в headless path
* provider SDK нестабилен при refresh
* CI/CD режим
* серверный unattended run

Это как у Claude Code: для subagent path API key сейчас надёжнее OAuth. ([GitHub][4])

---

# Минимальный roadmap

## Фаза 1. Починить сейчас

* [ ] создать `resolveProviderAuth.ts`
* [ ] подключить его в TUI
* [ ] подключить его в CLI `--mode json`
* [ ] научить Gemini/OpenAI/Kimi брать auth из resolver
* [ ] добавить fallback “inherit parent provider/model”

## Фаза 2. Убрать расхождение путей

* [ ] сделать `createProviderClient()`
* [ ] удалить provider-specific auth branching из `agent-runner.ts`
* [ ] унифицировать token refresh
* [ ] покрыть тестами OAuth/API-key paths

## Фаза 3. Довести до production-grade

* [ ] profile-based `auth.json`
* [ ] explicit auth precedence rules
* [ ] subagent auth policies
* [ ] logging/telemetry по source auth
* [ ] secure secret refs вместо plaintext, где возможно

---

# Набор тестов

## Unit

1. `resolveProviderAuth` берёт `process.env`, если ключ есть
2. если env пустой — берёт `.env`
3. если `.env` пустой — берёт `auth.json`
4. explicit CLI flag имеет приоритет над `auth.json`
5. OAuth token refresh вызывается при expiry
6. сабагент без model/provider наследует parent context
7. сабагент с другим provider не наследует чужой OAuth молча

## Integration

1. TUI login через OAuth → сабагент в `--mode json` работает
2. Kimi через `KIMI_API_KEY` работает и в TUI, и в CLI
3. `.env` с фейковым `GEMINI_API_KEY`, но валидный OAuth в `auth.json`:

   * система должна выбрать корректный источник по policy
4. родитель Gemini OAuth → child Gemini работает
5. родитель Kimi API key → child inherit работает
6. child explicit OpenAI без ключа → понятная ошибка, не silent fallback

## Regression

Сценарий, который у тебя ломается сейчас:

* parent TUI авторизован через browser OAuth
* сабагент спавнится через CLI JSON mode
* child делает успешный provider call без наличия `GEMINI_API_KEY` в env

---

# Ошибки, которые нельзя допустить

## 1. Не мапить всё в env навсегда

Это сделает архитектуру хрупкой.

## 2. Не смешивать auth source и model selection

Выбор модели и выбор credentials — разные задачи.

## 3. Не делать silent fallback между провайдерами

Если child попросил Gemini, а реально ушёл в Kimi — это опасно.

## 4. Не давать `auth.json` перекрывать явный CLI override

Иначе будет тяжёлый дебаг.

## 5. Не дублировать refresh-логику в TUI и CLI

Она должна жить в одном месте.

---

# Оптимальный итоговый дизайн

## Базовый принцип

**Сабагент — это не отдельный “CLI с пустым env”**.
Это **ещё один execution context в рамках общей auth системы Pi**.

## Значит

* auth должен быть session-aware
* provider resolution должен быть общий
* storage должен быть единым
* env — только один из источников, а не фундамент всей системы

---

# Резюме

**Оптимальный план для Pi:**

1. Вынести auth в общий `resolveProviderAuth`.
2. Подключить его и к TUI, и к CLI/`--mode json`.
3. Передавать сабагентам auth context reference, а не API key строки.
4. Перевести provider clients на единый `ResolvedAuth`.
5. Формализовать profile-based `auth.json`.
6. Оставить API keys как fallback, а не как основную модель.

Если нужно, следующим сообщением дам **конкретную структуру файлов и псевдокод для `resolveProviderAuth.ts`, `agent-runner.ts` и subagent spawn contract**.

[1]: https://docs.openclaw.ai/concepts/oauth?utm_source=chatgpt.com "OAuth"
[2]: https://opencode.ai/docs/agents/?utm_source=chatgpt.com "Agents"
[3]: https://opencode.ai/docs/troubleshooting/?utm_source=chatgpt.com "Troubleshooting"
[4]: https://github.com/anthropics/claude-code/issues/13741?utm_source=chatgpt.com "Task tool subagents fail with \"OAuth authentication is ..."
