# theeMatch — Event Backend (Vercel + Firestore)

Серверная (authoritative) логика событий: 2-часовой ивент, 3-минутные попытки,
фиксированные жизни (вариант B), best-score лидерборд, серверные награды.

## Что тут
```
backend/
  package.json          — зависимости (@google-cloud/firestore)
  vercel.json           — cron (финализация каждые 5 мин)
  firestore.rules       — запрет клиентских записей (только бэкенд)
  lib/db.js             — Firestore Admin + конфиг ивента
  lib/event.js          — детерминированные слоты события (серверное время)
  lib/validate.js       — античит (правдоподобность результата)
  api/event/info.js     — состояние события + мои жизни/лучший счёт/награды
  api/event/start.js    — атомарный старт попытки (-1 жизнь)
  api/event/submit.js   — приём результата + обновление best_score
  api/event/leaderboard.js — топ-N
  api/event/rewards.js  — мои награды
  api/event/claim.js    — атомарная выдача награды (idempotent)
  api/cron/finalize.js  — финализация закончившихся событий (cron)
```

## Что нужно сделать тебе (разово)

### 1. Firebase: Service Account (ключ)
1. Консоль Firebase `theematch-f07ae` → ⚙️ **Project settings** → **Service accounts**.
2. **Generate new private key** → скачается `.json`.
3. В Vercel создай **env-переменную** `GOOGLE_CREDENTIALS_JSON` и вставь **всё содержимое** этого `.json` (это и есть `GOOGLE_APPLICATION_CREDENTIALS`).

> 🔒 Никто не должен видеть этот файл — это доступ к твоей БД.

### 2. Firebase: Security Rules
В консоли Firebase → **Firestore** → вкладка **Rules** → замени содержимое на `backend/firestore.rules` → **Publish**.
Это запрещает клиенту напрямую писать в `events/attempts/rewards/lives/leaderboard/progress` — всё только через бэкенд.

### 3. Vercel: деплой
1. Создай репозиторий на GitHub и залей папку `backend/` (package.json наверху).
2. На vercel.com → **Add New Project** → импортируй этот репозиторий.
3. Framework: **Other** (это Node functions, Vercel сам определит `api/`).
4. Добавь env `GOOGLE_CREDENTIALS_JSON` (шаг 1.3). **Deploy**.

После деплоя вернётся URL вида `https://<project>.vercel.app`. Запиши его — понадобится в Godot.

### 4. Cron (финализация)
`vercel.json` уже задаёт cron `*/5 * * * *` → `/api/cron/finalize`.
На **бесплатном (hobby)** плане Vercel cron работает. Если нужна уверенность — включи в настройках проекта.

## Проверка
После деплоя протестируй:
```
curl -X POST https://<project>.vercel.app/api/event/info -H "Content-Type: application/json" -d '{"vk_user_id":"1"}'
curl -X POST https://<project>.vercel.app/api/event/start -H "Content-Type: application/json" -d '{"vk_user_id":"1"}'
```
Старт должен вернуть `attempt_id` и `ends_at`.

## Далее
После деплоя переключаем Godot на эти эндпоинты (VK.gd + GameManager + EventPanel).