// POST /api/event/start
// Атомарный старт попытки: проверяет событие/время/жизни, списывает 1 жизнь,
// создаёт attempt. Idempotent: повторный вызов в течение активной попытки не списывает
// вторую жизнь, а возвращает существующий attempt (через attempt_token).
//
// Body: { vk_user_id }
import { initDb, getEventConfig } from "../../lib/db.js";
import { currentEventInfo, canStartAttempt } from "../../lib/event.js";
import { spendLife } from "../../lib/lives.js";
import { createHash } from "crypto";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  let body = {};
  if (typeof req.body === "object" && req.body !== null) { body = req.body; }
  else { try { body = JSON.parse(req.body || "{}"); } catch (e) {} }
  const uid = String(body.vk_user_id || "");
  if (!uid) return res.status(400).json({ ok: false, error: "no_uid" });

  const fire = initDb();
  const cfg = await getEventConfig();
  const now = Date.now();
  const info = currentEventInfo(now, cfg);
  const check = canStartAttempt(now, info, cfg);
  if (!check.ok) return res.status(400).json({ ok: false, error: check.reason });

  // Idempotency-токен: один attempt на общего пользователя-событие на время попытки.
  // Если такой attempt ещё "started" и не истёк — возвращаем его (не списываем 2-ю жизнь).
  const attemptsColl = fire.collection(`events/${info.eventId}/attempts`);
  const started = await attemptsColl.where("uid", "==", uid)
    .where("status", "==", "started").get();
  if (!started.empty) {
    for (const doc of started.docs) {
      const a = doc.data();
      if (a.ends_at && a.ends_at > now) {
        // активная попытка уже есть — повторный старт безопасен
        return res.status(200).json({
          ok: true, body: { attempt_id: doc.id, ends_at: a.ends_at, reused: true },
        });
      }
    }
  }

  // Атомарное списание жизни (с ленивым регеном) + создание attempt.
  const attemptId = createHash("sha1").update(`${uid}.${info.eventId}.${now}.${Math.random()}`).digest("hex").slice(0, 16);
  const endsAt = now + cfg.attempt_ms;
  let created = false;
  try {
    const spent = await spendLife(fire, uid, info.eventId, cfg.max_lives);
    if (!spent.ok) return res.status(400).json({ ok: false, error: "no_lives" });
    created = true;
    await attemptsColl.doc(attemptId).set({
      uid, event_id: info.eventId,
      started_at: now, ends_at: endsAt, submitted_at: 0, score: 0,
      status: "started", duration: 0, waves: 0, moves: 0, combos: 0, destroyed: 0,
    });
  } catch (err) {
    const reason = (err && err.code !== undefined) ? err.code : "tx_failed";
    return res.status(500).json({ ok: false, error: reason, detail: String(err) });
  }

  res.status(200).json({
    ok: true,
    body: { attempt_id: attemptId, ends_at: endsAt, event_id: info.eventId, created },
  });
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}