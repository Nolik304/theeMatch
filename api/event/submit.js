// POST /api/event/submit
// Принимает результат попытки, валидирует (античит), помечает attempt submitted,
// и если score > best_score — обновляет leaderboard (players/{uid}).
// Idempotent: повторный submit того же attempt не дублирует запись и не меняет счёт дважды.
//
// Body: { vk_user_id, attempt_id, score, duration, waves, moves, combos, destroyed }
import { initDb, getEventConfig } from "../../lib/db.js";
import { currentEventInfo } from "../../lib/event.js";
import { validateScore } from "../../lib/validate.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  let body = {};
  if (typeof req.body === "object" && req.body !== null) { body = req.body; }
  else { try { body = JSON.parse(req.body || "{}"); } catch (e) {} }
  const uid = String(body.vk_user_id || "");
  const attemptId = String(body.attempt_id || "");
  if (!uid || !attemptId) return res.status(400).json({ ok: false, error: "bad_args" });

  const fire = initDb();
  const cfg = await getEventConfig();
  const now = Date.now();
  const info = currentEventInfo(now, cfg);

  // Читаем attempt. Используем collectionGroup по attempt_id? Лучше держать попытки
  // внутри события, но попытка должна быть найдена по id. У нас события детерминированы,
  // поэтому пытаемся в текущем событии (обычный случай) — submit проходит сразу после игры.
  let attemptDoc = null;
  let eventId = info.eventId;
  for (const eid of [info.eventId, info.eventId - 1]) {
    const ref = fire.doc(`events/${eid}/attempts/${attemptId}`);
    const snap = await ref.get();
    if (snap.exists) { attemptDoc = snap; eventId = eid; break; }
  }
  if (!attemptDoc) return res.status(404).json({ ok: false, error: "attempt_not_found" });
  const attempt = attemptDoc.data();

  // Проверки целостности
  if (String(attempt.uid) !== uid) return res.status(403).json({ ok: false, error: "wrong_uid" });
  if (attempt.status === "submitted") {
    // idempotent: уже принят
    const player = await fire.doc(`events/${eventId}/players/${uid}`).get();
    const best = player.exists ? player.data().best_score || 0 : 0;
    return res.status(200).json({ ok: true, body: { already: true, best_score: best } });
  }
  // Попытка должна быть ещё актуальна (не после окончания события слишком надолго)
  if (now > attempt.ends_at + cfg.attempt_ms * 0.25) {
    return res.status(400).json({ ok: false, error: "attempt_expired" });
  }

  // Античит
  const score = Math.max(0, Math.round(+body.score || 0));
  const v = validateScore({
    score, duration: +body.duration, waves: +body.waves,
    moves: +body.moves, combos: +body.combos, destroyed: +body.destroyed,
  }, cfg);
  if (!v.ok) return res.status(400).json({ ok: false, error: "rejected", detail: v.errors });

  // Атомарно: пометить submitted + обновить лучший счёт (только выше)
  let best = 0;
  await fire.runTransaction(async (tx) => {
    const attemptRef = attemptDoc.ref;
    const playerRef = fire.doc(`events/${eventId}/players/${uid}`);
    tx.update(attemptRef, {
      score, submitted_at: now,
      duration: +body.duration, waves: +body.waves,
      moves: +body.moves, combos: +body.combos, destroyed: +body.destroyed,
      status: "submitted",
    });
    const pSnap = await tx.get(playerRef);
    const prevBest = pSnap.exists ? pSnap.data().best_score || 0 : 0;
    best = Math.max(prevBest, score);
    tx.set(playerRef, {
      best_score: best,
      name: String(body.name || ""),
      avatar: String(body.avatar || ""),
      best_attempt_id: attemptId,
      updated_at: now,
    }, { merge: true });
  });

  res.status(200).json({ ok: true, body: { accepted: true, best_score: best, is_record: score > 0 && score === best } });
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}