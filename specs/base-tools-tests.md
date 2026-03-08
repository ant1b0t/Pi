# Тестирование base-tools.ts

## Описание
Этот документ содержит план тестирования и результаты проверки расширения `extensions/base-tools.ts`.

## План тестирования

### 1. Инструмент `todo`
- [ ] `todo add text="Test task"` — Добавление новой задачи.
- [ ] `todo list` — Список всех задач.
- [ ] `todo in_progress id=1` — Перевод задачи в статус "в процессе".
- [ ] `todo done id=1` — Завершение задачи.
- [ ] `todo toggle id=1` — Переключение статуса завершенности.
- [ ] `todo cancel id=1` — Отмена задачи.
- [ ] `todo clear` — Очистка списка задач.

### 2. Инструмент `glob`
- [ ] `glob pattern="*.ts"` — Поиск TS файлов в текущей директории.
- [ ] `glob pattern="**/*.ts" limit=5` — Рекурсивный поиск с лимитом.
- [ ] `glob pattern="**/*" ignore=["node_modules/**"]` — Поиск с игнорированием.
- [ ] `glob pattern="extensions/" include_dirs=true` — Поиск директорий.

### 3. Инструмент `web_fetch`
- [ ] `web_fetch url="https://example.com"` — Загрузка контента (Markdown).
- [ ] `web_fetch url="https://example.com" format="text"` — Загрузка в текстовом формате.
- [ ] `web_fetch url="https://example.com" format="html"` — Загрузка в HTML формате.
- [ ] `web_fetch url="http://localhost"` — Проверка блокировки локальных адресов.

### 4. Инструмент `ask_user`
- [ ] `ask_user question="Test?" options=["Yes", "No"]` — Выбор из предложенных вариантов.
- [ ] `ask_user question="Test freeform?"` — Свободный ввод текста.

## Результаты тестирования

### 1. Инструмент `todo`
- [x] `todo add text="Test task"` — Успешно добавлена задача.
- [x] `todo list` — Успешно выведен список задач.
- [x] `todo in_progress id=10` — Успешно установлен статус "в процессе".
- [x] `todo toggle id=10` — Успешно переключен статус (завершена/открыта).
- [x] `todo cancel id=10` — Успешно отменена.
- [x] `todo done id=6` — Успешно завершена (после перевода в `in_progress`).

### 2. Инструмент `glob`
- [x] `glob pattern="*.ts" cwd="extensions"` — Успешно найдены файлы в поддиректории.
- [x] `glob pattern="*.ts" limit=2` — Успешно применен лимит.
- [x] `glob pattern="**/*" ignore=["**/*.ts"]` — Успешно применено игнорирование (результат пуст при поиске только по TS).
- [x] `glob pattern="*" include_dirs=true` — Успешно найдены директории (с суффиксом `/`).

### 3. Инструмент `web_fetch`
- [x] `web_fetch url="https://www.google.com"` — Успешно загружен Markdown.
- [x] `web_fetch url="https://www.google.com" format="text"` — Успешно загружен текст без Markdown разметки.
- [x] `web_fetch url="https://www.google.com" format="html"` — Успешно загружен сырой HTML (с обрезанием по лимиту байт).
- [x] `web_fetch url="http://localhost:8080"` — Успешно заблокирован доступ к локальному адресу (INVALID_ARGUMENT).

### 4. Инструмент `ask_user`
- [x] `ask_user question="..." options=["..."]` — Успешно получен выбор пользователя.
- [x] `ask_user question="..."` — Успешно получен свободный ввод пользователя.

**Итог:** Все основные функции `base-tools.ts` работают корректно.
