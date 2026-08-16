# supabase-api — Server-authoritative event API (Express + PostgreSQL/Supabase)

Replaces the old Vercel + Firebase backend. The Godot client talks ONLY to this API;
Supabase is never accessed directly from the client (service-role credentials stay server-side,
and RLS keeps anon clients locked out).

## Structure
```
supabase-api/
  schema.sql        -> run in Supabase SQL Editor (tables + RLS)
  server.js         -> Express app (status/start/submit/leaderboard/rewards/claim)
  lib/event.js      -> deterministic event slots + CFG
  lib/validate.js   -> anti-cheat plausibility grid
  lib/db.js         -> pg Pool (reads DATABASE_URL)
  package.json
  .env.example
```

## Deploy (Render / Railway / cheap VPS)
1. Apply `schema.sql` in Supabase -> SQL Editor.
2. Set env vars from `.env.example`
   (DATABASE_URL, APP_SECRET, ADMIN_TOKEN, CRON_TOKEN).
3. `npm install` + `npm start`.
   - Render: build `npm install`, start `npm start`.
   - Railway: auto-detects; set the env vars, deploy.
   - VPS: `npm install --omit=dev`, `pm2 start server.js --name api`,
     nginx reverse proxy to 127.0.0.1:3000, certbot for HTTPS.
4. Cron `/api/cron/finalize` every 5 min
   (Render Cron / VPS crontab `curl -X POST .../api/cron/finalize -d '{"cron_token":"..."}'`).

## Smoke test
```
curl -X POST http://localhost:3000/api/event/status -H "Content-Type: application/json" -d '{"vk_user_id":"1"}'
curl -X POST http://localhost:3000/api/event/start  -H "Content-Type: application/json" -d '{"vk_user_id":"1"}'
# returns attempt_id + server-issued seed + HMAC token; submit it back within the window.
```

## Honest validation
- Server issues `seed` at `/start` and returns an HMAC `token`; `/submit` verifies
  seed + token + time window + plausible score (anti-cheat grid), and a tighter cap
  for campaign seeds whose expected score was computed by the offline bot
  (`levels_seeds.expected_score`).
- Leaderboard is written only by the server (`unique(event_id, player_id)` = one row
  per player per event, score keeps the maximum).
- Suspicious attempts are flagged (`attempts.suspicious` + `players.flags`).
