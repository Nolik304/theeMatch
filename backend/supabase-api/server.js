// server.js — Server-authoritative event API (Express + PostgreSQL/Supabase).
// The Godot client talks ONLY to this API. No direct Supabase access from the client.
import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import pg from "pg";
import { CFG, currentEventInfo } from "./lib/event.js";
import { validateScore } from "./lib/validate.js";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
});

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"] }));
app.use(express.json());

const SECRET = process.env.APP_SECRET || "dev-secret-change-me";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const CRON_TOKEN = process.env.CRON_TOKEN || "";

// ---------- helpers ----------
function bodyOf(req) {
  return req.method === "GET" ? req.query : (req.body || {});
}

function hmacToken(attemptId, seed, endsAtMs) {
  return crypto.createHmac("sha256", SECRET)
    .update(`${attemptId}.${seed}.${endsAtMs}`).digest("hex");
}

function tokenOk(a, token) {
  const expected = hmacToken(a.id, a.seed, new Date(a.ends_at).getTime());
  const given = String(token || "");
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

async function markSuspicious(playerId, eventId) {
  await pool.query(
    `update players set flags = array_append(flags, $2)
     where user_id = $1::bigint and not (flags @> array[$2])`,
    [playerId, "sus:" + eventId]);
}

function reject(res, status, data) {
  res.status(status).json({ ok: false, ...data });
}

// Events row is lazy: leaderboard_records/rewards have an FK to events(id),
// so the slot row must exist before writing. Idempotent.
async function ensureEvent(client, eventId) {
  const slotLen = CFG.event_duration_ms + CFG.cooldown_ms;
  await client.query(
    `insert into events (id, active_start, active_end, next_start, status)
     values ($1,$2,$3,$4,'active')
     on conflict (id) do nothing`,
    [eventId, new Date(eventId * slotLen), new Date((eventId + 1) * slotLen - CFG.cooldown_ms),
     new Date((eventId + 1) * slotLen)]);
}


// ---------- health ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---------- POST/GET /api/event/status ----------
app.all("/api/event/status", async (req, res) => {
  const b = bodyOf(req);
  const uid = String(b.vk_user_id || "");
  const now = Date.now();
  const info = currentEventInfo(now);
  let me = null;
  if (uid) {
    const p = (await pool.query(`select * from players where user_id=$1::bigint`, [uid])).rows[0];
    const rec = (await pool.query(
      `select score from leaderboard_records where event_id=$1 and player_id=$2::bigint`,
      [info.eventId, uid])).rows[0];
    // Жизни — общий (глобальный) ресурс, не привязанный к событию и не сбрасываемый.
    const lives = p ? p.lives : CFG.max_lives;
    me = { lives, max_lives: CFG.max_lives, coins: (p && p.coins) || 0, best_score: rec ? rec.score : 0 };
  }
  res.json({ ok: true, body: { ...info, attempt_ms: CFG.attempt_ms, me } });
});

// ---------- POST /api/event/start (idempotent, -1 life) ----------
app.post("/api/event/start", async (req, res) => {
  const uid = String((req.body || {}).vk_user_id || "");
  if (!uid) return reject(res, 400, { error: "no_uid" });
  const now = Date.now();
  const info = currentEventInfo(now);
  if (!info.active) return reject(res, 400, { error: "event_not_active" });
  if (info.activeEnd - now < CFG.attempt_ms) return reject(res, 400, { error: "not_enough_time" });

  const active = (await pool.query(
    `select * from attempts where player_id=$1::bigint and event_id=$2 and status='started' and ends_at>now()
     order by ends_at desc limit 1`, [uid, info.eventId])).rows[0];
  if (active)
    // 3-минутная попытка ещё не истекла: повторный заход запрещён.
    // Ответ отдаёт ends_at, чтобы клиент восстановил «Идёт попытка…» и не списывал жизнь.
    return reject(res, 400, {
      error: "attempt_in_progress",
      attempt_id: active.id,
      ends_at: new Date(active.ends_at).getTime(),
      event_id: info.eventId,
    });

  const client = await pool.connect();
  try {
    await client.query("begin");
    let p = (await client.query(`select * from players where user_id=$1::bigint for update`, [uid])).rows[0];
    if (!p) {
      // Новый игрок: создаём с полным запасом жизней. Жизни — общий ресурс, без сброса по событию.
      await client.query(
        `insert into players (user_id, lives) values ($1, $2) on conflict (user_id) do nothing`,
        [uid, CFG.max_lives]);
      p = (await client.query(`select * from players where user_id=$1::bigint for update`, [uid])).rows[0];
    }
    if (p.lives <= 0) { await client.query("rollback"); return reject(res, 400, { error: "no_lives" }); }

    const attemptId = crypto.randomBytes(8).toString("hex");
    const seed = crypto.randomInt(1, 2 ** 31);       // server issues the seed
    const endsAt = now + CFG.attempt_ms;
    const token = hmacToken(attemptId, seed, endsAt);
    await client.query(`update players set lives=lives-1 where user_id=$1 and lives>0`, [uid]);
    await client.query(
      `insert into attempts (id, event_id, player_id, seed, token, started_at, ends_at)
       values ($1,$2,$3,$4,$5, now(), to_timestamp($6/1000.0))`,
      [attemptId, info.eventId, uid, seed, token, endsAt]);
    await client.query("commit");
    res.json({ ok: true, body: { attempt_id: attemptId, seed, token, ends_at: endsAt, event_id: info.eventId, created: true } });
  } catch (e) {
    await client.query("rollback");
    reject(res, 500, { error: "db_error" });
  } finally { client.release(); }
});

// ---------- POST /api/event/submit (validation + leaderboard write) ----------
app.post("/api/event/submit", async (req, res) => {
  const { vk_user_id, attempt_id, seed, score, checksum, token, duration, waves, moves, combos, destroyed, name, avatar } = req.body || {};
  if (!vk_user_id || !attempt_id) return reject(res, 400, { error: "bad_args" });

  const a = (await pool.query(
    `select * from attempts where id=$1 and player_id=$2::bigint`, [attempt_id, vk_user_id])).rows[0];
  if (!a) return reject(res, 404, { error: "attempt_not_found" });
  if (String(a.seed) !== String(seed)) return reject(res, 400, { error: "seed_mismatch" });
  if (!tokenOk(a, token)) return reject(res, 403, { error: "bad_token" });

  if (a.status === "submitted") {
    const r = (await pool.query(
      `select score from leaderboard_records where event_id=$1 and player_id=$2`, [a.event_id, a.player_id])).rows[0];
    return res.json({ ok: true, body: { accepted: true, already: true, best_score: r ? r.score : 0 } });
  }
  // Брошенная / отклонённая попытка не может дать рекорд/награду.
  if (a.status === "cancelled")
    return reject(res, 400, { error: "attempt_cancelled" });
  if (a.status === "rejected")
    return reject(res, 400, { error: "attempt_rejected" });

  const now = Date.now();
  if (now > new Date(a.ends_at).getTime() + CFG.attempt_ms * 0.25)
    return reject(res, 400, { error: "attempt_expired" });

  const s = Math.max(0, Math.round(+score || 0));
  // Игрок не сыграл (0 очков) — такая «попытка» не попадает в топ и не даёт приз.
  if (s <= 0) {
    await pool.query(
      `update attempts set status='cancelled', submitted_at=now() where id=$1`, [attempt_id]);
    return reject(res, 400, { error: "score_zero" });
  }
  const v = validateScore({ score: s, duration, waves, moves, combos, destroyed });
  if (!v.ok) {
    await pool.query(
      `update attempts set status='rejected', score=$2, reject_reasons=$3, suspicious=true, submitted_at=now()
       where id=$1`, [attempt_id, s, v.errors]);
    await markSuspicious(a.player_id, a.event_id);
    return reject(res, 400, { error: "rejected", detail: v.errors });
  }

  // Campaign seeds have an expected score from the bot simulation -> tighter cap.
  const seedRow = (await pool.query(
    `select expected_score from levels_seeds where seed=$1`, [seed])).rows[0];
  if (seedRow && s > Math.max(seedRow.expected_score, 1) * 2.5) {
    await pool.query(
      `update attempts set status='rejected', score=$2,
       reject_reasons=array['score_above_expected'], suspicious=true, submitted_at=now() where id=$1`,
      [attempt_id, s]);
    await markSuspicious(a.player_id, a.event_id);
    return reject(res, 400, { error: "rejected", detail: ["score_above_expected"] });
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    await ensureEvent(client, a.event_id);
    await client.query(
      `update attempts set status='submitted', score=$1, duration_ms=$2, waves=$3, moves=$4,
       combos=$5, destroyed=$6, checksum=$7, submitted_at=now() where id=$8`,
      [s, +duration || 0, +waves || 0, +moves || 0, +combos || 0, +destroyed || 0, checksum || "", attempt_id]);
    const up = (await client.query(
      `insert into leaderboard_records (event_id, player_id, score, duration_ms, seed, checksum)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (event_id, player_id)
       do update set score = greatest(leaderboard_records.score, excluded.score),
                     duration_ms = excluded.duration_ms,
                     checksum = excluded.checksum,
                     updated_at = now()
       returning score`,
      [a.event_id, a.player_id, s, +duration || 0, a.seed, checksum || ""])).rows[0];
    await client.query(
      `update players set display_name=$2, avatar_url=$3 where user_id=$1::bigint`,
      [a.player_id, String(name || "").slice(0, 64), String(avatar || "").slice(0, 256)]);
    await client.query("commit");
    res.json({ ok: true, body: { accepted: true, best_score: up.score, is_record: up.score === s } });
  } catch (e) {
    await client.query("rollback");
    reject(res, 500, { error: "db_error" });
  } finally { client.release(); }
});

// ---------- POST/GET /api/event/leaderboard (ready top list) ----------
app.all("/api/event/leaderboard", async (req, res) => {
  const b = bodyOf(req);
  const info = currentEventInfo(Date.now());
  const eventId = Number.isFinite(+b.event_id) ? +b.event_id : info.eventId;
  const limit = Math.min(50, Math.max(1, parseInt(b.limit || "20", 10) || 20));
  const rows = (await pool.query(
    `select r.player_id as vk_user_id, r.score, 1 as best_level, p.display_name as name, p.avatar_url as avatar
     from leaderboard_records r join players p on p.user_id = r.player_id
     where r.event_id=$1 order by r.score desc limit $2`, [eventId, limit])).rows;
  const uid = String(b.vk_user_id || "");
  let me = { uid, score: 0, pos: -1 };
  if (uid) {
    const my = (await pool.query(
      `select score from leaderboard_records where event_id=$1 and player_id=$2::bigint`,
      [eventId, uid])).rows[0];
    if (my) {
      const pos = (await pool.query(
        `select count(*)::int as c from leaderboard_records where event_id=$1 and score>$2`,
        [eventId, my.score])).rows[0].c + 1;
      me = { uid, score: my.score, pos };
    }
  }
  res.json({ ok: true, body: { eventId, rows, me } });
});

// ---------- POST/GET /api/event/rewards (my rewards) ----------
app.all("/api/event/rewards", async (req, res) => {
  const b = bodyOf(req);
  const uid = String(b.vk_user_id || "");
  if (!uid) return reject(res, 400, { error: "no_uid" });
  const eventId = Number.isFinite(+b.event_id) ? +b.event_id : null;
  if (eventId !== null) {
    const r = (await pool.query(
      `select * from rewards where event_id=$1 and player_id=$2::bigint`, [eventId, uid])).rows[0] || null;
    return res.json({ ok: true, body: r });
  }
  const rs = (await pool.query(
    `select event_id, rank, coins, boosters, claimed from rewards
     where player_id=$1::bigint order by event_id desc limit 20`, [uid])).rows;
  res.json({ ok: true, body: rs });
});

// ---------- POST /api/event/claim (atomic reward grant, idempotent) ----------
app.post("/api/event/claim", async (req, res) => {
  const uid = String((req.body || {}).vk_user_id || "");
  const eventId = parseInt((req.body || {}).event_id, 10);
  if (!uid || !Number.isFinite(eventId)) return reject(res, 400, { error: "bad_args" });
  const client = await pool.connect();
  try {
    await client.query("begin");
    const r = (await client.query(
      `select * from rewards where event_id=$1 and player_id=$2::bigint for update`, [eventId, uid])).rows[0];
    if (!r) { await client.query("rollback"); return reject(res, 400, { error: "no_reward" }); }
    if (r.claimed) { await client.query("rollback"); return res.json({ ok: true, body: { already: true, coins: r.coins, boosters: r.boosters, rank: r.rank } }); }
    await client.query(
      `update players set coins = coins + $1, boosters = boosters + $2, updated_at = now() where user_id=$3::bigint`,
      [r.coins, r.boosters, uid]);
    await client.query(`update rewards set claimed=true, claimed_at=now() where id=$1`, [r.id]);
    await client.query("commit");
    res.json({ ok: true, body: { already: false, coins: r.coins, boosters: r.boosters, rank: r.rank } });
  } catch (e) {
    await client.query("rollback");
    reject(res, 500, { error: "db_error" });
  } finally { client.release(); }
});

// ---------- POST /api/event/buy (1 life for coins) ----------
app.post("/api/event/buy", async (req, res) => {
  const uid = String((req.body || {}).vk_user_id || "");
  if (!uid) return reject(res, 400, { error: "no_uid" });
  const info = currentEventInfo(Date.now());
  if (!info.active) return reject(res, 400, { error: "event_not_active" });
  const client = await pool.connect();
  try {
    await client.query("begin");
    const p = (await client.query(`select * from players where user_id=$1::bigint for update`, [uid])).rows[0];
    if (!p) { await client.query("rollback"); return reject(res, 400, { error: "no_player" }); }
    if (p.coins < CFG.life_cost) { await client.query("rollback"); return reject(res, 400, { error: "not_enough_coins" }); }
    if (p.lives >= CFG.max_lives) { await client.query("rollback"); return reject(res, 400, { error: "lives_full" }); }
    await client.query(
      `update players set coins = coins - $1, lives = $2 where user_id=$3::bigint`,
      [CFG.life_cost, CFG.max_lives, uid]);
    await client.query("commit");
    res.json({ ok: true, body: { lives: CFG.max_lives, max_lives: CFG.max_lives, coins: p.coins - CFG.life_cost } });
  } catch (e) {
    await client.query("rollback");
    reject(res, 500, { error: "db_error" });
  } finally { client.release(); }
});

// ---------- POST /api/cron/finalize (run every 5 min) ----------
app.post("/api/cron/finalize", async (req, res) => {
  const t = String((req.body || {}).cron_token || "");
  if (t !== CRON_TOKEN && t !== ADMIN_TOKEN) return reject(res, 403, { error: "forbidden" });
  const now = Date.now();
  const info = currentEventInfo(now);
  let finalized = 0;
  let abandoned = 0;
  try {
    // «Начал и бросил, не сдал результат»: попытка истекла — закрываем её,
    // чтобы она больше не могла дать рекорд или награду.
    const ab = await pool.query(
      `update attempts set status='cancelled' where status='started' and ends_at < now()`
    );
    abandoned = ab.rowCount || 0;
    for (let step = 1; step <= 5; step++) {
      const eventId = info.eventId - step;
      const slotEnd = (eventId + 1) * (CFG.event_duration_ms + CFG.cooldown_ms) - CFG.cooldown_ms;
      if (slotEnd > now) break;
      if (await finalizeEvent(eventId)) finalized++;
    }
    res.json({ ok: true, body: { finalized, abandoned } });
  } catch (e) {
    reject(res, 500, { error: "db_error" });
  }
});

async function finalizeEvent(eventId) {
  const slotLen = CFG.event_duration_ms + CFG.cooldown_ms;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await ensureEvent(client, eventId);
    const ev = (await client.query(`select status from events where id=$1 for update`, [eventId])).rows[0];
    if (ev && ev.status === "finalized") { await client.query("commit"); return false; }
    const rows = (await client.query(
      `select player_id, score from leaderboard_records
       where event_id=$1 and score>0 order by score desc`, [eventId])).rows;
    for (let i = 0; i < rows.length; i++) {
      const rank = i + 1;
      const reward = CFG.prizes[rank] || CFG.participation_prize;
      await client.query(
        `insert into rewards (event_id, player_id, rank, coins, boosters, claimed)
         values ($1,$2,$3,$4,$5,false)
         on conflict (event_id, player_id) do nothing`,
        [eventId, rows[i].player_id, rank, reward.coins, reward.boosters]);
    }
    // Событие закрыто: больше никаких попыток/рекордов в него.
    await client.query(
      `update attempts set status='cancelled' where event_id=$1 and status='started'`,
      [eventId]);
    await client.query(
      `insert into events (id, active_start, active_end, next_start, status, finalized_at)
       values ($1,$2,$3,$4,'finalized',now())
       on conflict (id) do update set status='finalized', finalized_at=now()`,
      [eventId, new Date(eventId * slotLen), new Date((eventId + 1) * slotLen - CFG.cooldown_ms),
       new Date((eventId + 1) * slotLen)]);
    await client.query("commit");
    return rows.length > 0;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally { client.release(); }
}

// ---------- POST /api/admin/levels/import (bot JSON -> levels_seeds) ----------
app.post("/api/admin/levels/import", async (req, res) => {
  const b = req.body || {};
  if (b.admin_token !== ADMIN_TOKEN) return reject(res, 403, { error: "forbidden" });
  const seeds = Array.isArray(b.seeds) ? b.seeds : [];
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const s of seeds) {
      await client.query(
        `insert into levels_seeds
           (level_id, seed, width, height, colors, archetype, density, expected_actions, expected_score, checksum)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (level_id) do update set seed=$2, checksum=$10`,
        [s.level_id, s.seed, s.width, s.height, s.colors, s.archetype || "",
         s.density || 0, s.expected_actions || 0, s.expected_score || 0, s.checksum || ""]);
    }
    await client.query("commit");
    res.json({ ok: true, body: { imported: seeds.length } });
  } catch (e) {
    await client.query("rollback");
    reject(res, 500, { error: "db_error" });
  } finally { client.release(); }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("theematch-api listening on :" + port));
