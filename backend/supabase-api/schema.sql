-- =============================================================
-- Схема БД для событий «3 в ряд» (Supabase/PostgreSQL).
-- Запустить целиком в Supabase → SQL Editor.
-- Доступ к БД есть ТОЛЬКО у API (service_role) — клиент Godot
-- напрямую в Supabase НЕ ходит. RLS ниже — второй рубеж.
-- =============================================================

-- 1) players — профиль и экономика (баланс-критичное)
create table if not exists public.players (
  user_id           bigint primary key,             -- VK ID
  display_name      text    not null default '',
  avatar_url        text    not null default '',
  coins             integer not null default 0,
  boosters          integer not null default 3,
  unlocked_level    integer not null default 0,
  lives             integer not null default 5,     -- запас на текущее событие
  lives_event_id    bigint  not null default 0,     -- событие, к которому относится запас
  flags             text[]  not null default '{}',  -- 'sus:{event}' — античит-маркеры
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists players_unlocked_idx on public.players (unlocked_level);
create index if not exists players_lives_idx   on public.players (lives_event_id, lives);

-- 2) levels_seeds — сиды и метрики сложности, которые считает локальный бот.
--    Импорт один раз через POST /api/admin/levels/import (JSON от бота).
create table if not exists public.levels_seeds (
  id               bigserial primary key,
  level_id         integer not null unique,
  seed             bigint  not null,
  width            integer not null,
  height           integer not null,
  colors           integer not null,
  archetype        text    not null default '',
  density          real    not null default 0,
  expected_actions integer not null default 0,
  expected_score   integer not null default 0,
  checksum         text    not null default '',     -- sha256 канонической раскладки (бот)
  created_at       timestamptz not null default now()
);

-- 3) events — строка события (слот создаётся лениво при финализации)
create table if not exists public.events (
  id           bigint primary key,                  -- номер слота = floor(now / slot_len)
  active_start timestamptz not null,
  active_end   timestamptz not null,
  next_start   timestamptz not null,
  status       text not null default 'active'
               check (status in ('scheduled','active','finalized')),
  finalized_at timestamptz
);
create index if not exists events_active_idx on public.events (active_start, active_end);

-- 4) leaderboard_records — ТОП (пишет только сервер); одна строка на игрока-событие
create table if not exists public.leaderboard_records (
  id          bigserial primary key,
  event_id    bigint not null references public.events(id),
  player_id   bigint not null references public.players(user_id),
  score       integer not null check (score >= 0),
  duration_ms integer not null default 0,
  seed        bigint  not null default 0,
  checksum    text    not null default '',           -- клиентский hash игры (сигнал)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (event_id, player_id)
);
create index if not exists leaderboard_rank_idx  on public.leaderboard_records (event_id, score desc, updated_at asc);
create index if not exists leaderboard_player_idx on public.leaderboard_records (player_id);

-- 5) attempts — раунды «start → submit» (нужны для честной валидации)
create table if not exists public.attempts (
  id             text primary key,                  -- attempt_id
  event_id       bigint not null,
  player_id      bigint not null,
  seed           bigint not null,                   -- сид, который ВЫДАЛ СЕРВЕР
  token          text   not null,                   -- HMAC(seed+ends_at) — билет попытки
  status         text   not null default 'started'
                 check (status in ('started','submitted','rejected','cancelled')),
  started_at     timestamptz not null,
  ends_at        timestamptz not null,
  submitted_at   timestamptz,
  score          integer not null default 0,
  duration_ms    integer not null default 0,
  waves          integer not null default 0,
  moves          integer not null default 0,
  combos         integer not null default 0,
  destroyed      integer not null default 0,
  checksum       text    not null default '',
  suspicious     boolean not null default false,
  reject_reasons text[]  not null default '{}'
);
create index if not exists attempts_active_idx on public.attempts (status, ends_at);
create index if not exists attempts_player_idx on public.attempts (player_id, event_id);

-- 6) rewards — письма-призы
create table if not exists public.rewards (
  id         bigserial primary key,
  event_id   bigint not null references public.events(id),
  player_id  bigint not null references public.players(user_id),
  rank       integer not null,
  coins      integer not null default 0,
  boosters   integer not null default 0,
  claimed    boolean not null default false,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (event_id, player_id)
);
create index if not exists rewards_player_idx on public.rewards (player_id, claimed);

-- =============================================================
-- RLS: анонимный ключ НЕ видит/не пишет ничего. Всё — через API
-- (service_role обходит RLS). Ниже — опциональные политики
-- «свои строки / топ — всем» на случай read-only ключа для клиента.
-- =============================================================
alter table public.players             enable row level security;
alter table public.levels_seeds        enable row level security;
alter table public.events              enable row level security;
alter table public.leaderboard_records enable row level security;
alter table public.attempts            enable row level security;
alter table public.rewards             enable row level security;

-- 1) Полный блок анонима (копируй блок на каждую таблицу)
drop policy if exists anon_block_players on public.players;
create policy anon_block_players on public.players for all using (false) with check (false);

-- 2) «свои строки / топ — все» (опционально; идентификатор из кастомного claim
--    JWT {"vk_id": 123} — политики активны только если клиент получит JWT).
drop policy if exists players_own on public.players;
create policy players_own on public.players
  for select using (
    (current_setting('request.jwt.claims', true)::json->>'vk_id')::bigint = user_id
  );
drop policy if exists attempts_own on public.attempts;
create policy attempts_own on public.attempts
  for select using (
    (current_setting('request.jwt.claims', true)::json->>'vk_id')::bigint = player_id
  );
drop policy if exists rewards_own on public.rewards;
create policy rewards_own on public.rewards
  for select using (
    (current_setting('request.jwt.claims', true)::json->>'vk_id')::bigint = player_id
  );
drop policy if exists leaderboard_public on public.leaderboard_records;
create policy leaderboard_public on public.leaderboard_records for select using (true);

drop policy if exists events_public on public.events;
create policy events_public     on public.events             for select using (true);

drop policy if exists seeds_public on public.levels_seeds;
create policy seeds_public      on public.levels_seeds       for select using (true);
