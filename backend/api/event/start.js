// POST /api/event/start
// Атомарный старт попытки: проверяет событие/время/жизни, списывает 1 жизнь,
// создаёт attempt. Idempotent: повторный вызов в течение активной попытки не списывает
// вторую жизнь, а возвращает существующий attempt (через attempt_token).
//
// Body: { vk_user_id }
import { initDb, getEventConfig } from "../../lib/db.js";
import { currentEventInfo, canStartAttempt } from "../../lib/event.js";
import { createHash } from "crypto";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  let body = {};
  try { body = JSON.parse(req.body || "{}"); } catch (e) {}
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

  // Атомарная транзакция: проверить жизни и списать.
  const attemptId = createHash("sha1").update(`${uid}.${info.eventId}.${now}.${Math.random()}`).digest("hex").slice(0, 16);
  const endsAt = now + cfg.attempt_ms;
  let created = false;
  try {
    await fire.runTransaction(async (tx) => {
      const livesRef = fire.doc(`lives/${uid}`);
      const lSnap = await tx.get(livesRef);
      let lives = cfg.max_lives;
      if (lSnap.exists && lSnap.data().event_id === info.eventId) {
        lives = lSnap.data().lives;
      } else {
        // новый ивент — выдаём полный запас жизней
        lives = cfg.max_lives;
        tx.set(livesRef, { event_id: info.eventId, lives, updated_at: now });
      }
      if (lives <= 0) {
        // нельзя откатить живо в транзакции просто так; бросаем, чтобы не писало
        tx.set(livesRef, { event_id: info.eventId, lives: 0, updated_at: now }); // no-op guard
        throw { code: "no_lives" };
      }
      tx.update(livesRef, { lives: lives - 1, updated_at: now });
      const attemptRef = attemptsColl.doc(attemptId);
      tx.set(attemptRef, {
        uid, event_id: info.eventId,
        started_at: now, ends_at: endsAt, submitted_at: 0, score: 0,
        status: "started", duration: 0, waves: 0, moves: 0, combos: 0, destroyed: 0,
      });
      created = true;
    });
  } catch (err) {
    const reason = (err && err.code !== undefined) ? err.code : "tx_failed";
    if (reason === "no_lives") return res.status(400).json({ ok: false, error: "no_lives" });
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