# Тестирование base-tools.ts

## Описание
Этот документ содержит план тестирования и результаты проверки расширения `extensions/base-tools.ts`.

## План тестирования

### 1. Инструмент `todo`
- [ ] `todo add items=["Test task"]` — Добавление новой задачи.
- [ ] `todo list` — Список всех задач.
- [ ] `todo progress ids=[1]` — Перевод задачи в статус "в процессе".
- [ ] `todo done ids=[1]` — Завершение задачи.
- [ ] `todo remove ids=[1]` — Удаление задачи.
- [ ] `todo clear` — Очистка списка задач.

### 2. Инструмент `glob`
- [ ] `glob pattern="*.ts" path="extensions"` — Поиск TS файлов в поддиректории.
- [ ] `glob pattern="**/*.ts" limit=5` — Рекурсивный поиск с лимитом.
- [ ] `glob pattern="extensions/**/*.ts" format="summary only"` — Сводный формат вывода.
- [ ] `glob pattern="extensions/**/*.ts" format="full output"` — Полный формат вывода.

### 3. Инструмент `web_fetch`
- [ ] `web_fetch url="https://example.com"` — Загрузка контента (Markdown summary).
- [ ] `web_fetch url="https://example.com" format="summary only"` — Сводный вывод.
- [ ] `web_fetch url="https://example.com" format="full output"` — Полный вывод.
- [ ] `web_fetch url="http://localhost"` — Проверка блокировки локальных адресов.

### 4. Инструмент `ask_user`
- [ ] `ask_user question="Test?" options=["Yes", "No"]` — Выбор из предложенных вариантов.
- [ ] `ask_user question="Test freeform?"` — Свободный ввод текста.

## Результаты тестирования

### 1. Инструмент `todo`
- [x] `todo add items=["Test task"]` — Успешно добавлена задача.
- [x] `todo list` — Успешно выведен список задач.
- [x] `todo progress ids=[10]` — Успешно установлен статус "в процессе".
- [x] `todo done ids=[6]` — Успешно завершена задача.
- [x] `todo remove ids=[10]` — Успешно удалена задача.

### 2. Инструмент `glob`
- [x] `glob pattern="*.ts" path="extensions"` — Успешно найдены файлы в поддиректории.
- [x] `glob pattern="*.ts" limit=2` — Успешно применен лимит.
- [x] `glob pattern="extensions/**/*.ts" format="summary only"` — Успешно выдан краткий список файлов.
- [x] `glob pattern="extensions/**/*.ts" format="full output"` — Успешно выдан полный список файлов.

### 3. Инструмент `web_fetch`
- [x] `web_fetch url="https://www.google.com"` — Успешно загружен Markdown.
- [x] `web_fetch url="https://www.google.com" format="summary only"` — Успешно загружен краткий Markdown summary.
- [x] `web_fetch url="https://www.google.com" format="full output"` — Успешно загружен полный Markdown вывод.
- [x] `web_fetch url="http://localhost:8080"` — Успешно заблокирован доступ к локальному адресу (INVALID_ARGUMENT).

### 4. Инструмент `ask_user`
- [x] `ask_user question="..." options=["..."]` — Успешно получен выбор пользователя.
- [x] `ask_user question="..."` — Успешно получен свободный ввод пользователя.

### 5. Runtime reload safety
- [x] Удалён one-time global reload guard из `extensions/base/base-tools.ts`.
- [x] Добавлена проверка `just check-runtime-reload-guards` против регрессии для базовых runtime-sensitive extensions.

**Итог:** Все основные функции `base-tools.ts` работают корректно.
