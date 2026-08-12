// POST /api/event/claim
// Атомарно выдать награду за событие (только если событие финализировано и награда
// назначена). Idempotent: повторный claim возвращает уже выданную награду без повтора.
// Награда начисляется в существующую экономику (progress/{uid}) — coins/boosters.
//
// Body: { vk_user_id, event_id }
import { initDb, getEventConfig } from "../../lib/db.js";
import { currentEventInfo } from "../../lib/event.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  let body = {};
  if (typeof req.body === "object" && req.body !== null) { body = req.body; }
  else { try { body = JSON.parse(req.body || "{}"); } catch (e) {} }
  const uid = String(body.vk_user_id || "");
  const eventId = parseInt(body.event_id, 10);
  if (!uid || !Number.isFinite(eventId)) return res.status(400).json({ ok: false, error: "bad_args" });

  const fire = initDb();
  const cfg = await getEventConfig();

  // Событие должно быть окончательно закрыто (реврад назначен)
  const eventRef = fire.doc(`events/${eventId}`);
  const eSnap = await eventRef.get();
  if (!eSnap.exists) {
    // событие может быть детерминированным (нет документа) и не финализировано
    return res.status(400).json({ ok: false, error: "event_not_finalized" });
  }
  if (eSnap.data().status !== "finalized") {
    return res.status(400).json({ ok: false, error: "event_not_finalized" });
  }

  const rewardRef = fire.doc(`events/${eventId}/rewards/${uid}`);
  let result = null;
  await fire.runTransaction(async (tx) => {
    const rSnap = await tx.get(rewardRef);
    if (rSnap.exists && rSnap.data().claimed) {
      result = { already: true, ...rSnap.data() };
      return;
    }
    if (!rSnap.exists) {
      // нет награды для этого игрока — вероятно не участвовал
      result = { none: true };
      return;
    }
    const r = rSnap.data();
    // начисляем в экономику (progress/{uid}.coins/.boosters) — атомарно
    const progRef = fire.doc(`progress/${uid}`);
    const pSnap = await tx.get(progRef);
    const prev = pSnap.exists ? pSnap.data() : {};
    tx.set(progRef, {
      ...prev,
      coins: (prev.coins || 0) + (r.coins || 0),
      boosters: (prev.boosters || 0) + (r.boosters || 0),
      updated_at: nowTs(),
    }, { merge: true });
    tx.update(rewardRef, { claimed: true, claimed_at: nowTs(), uid });
    result = { already: false, coins: r.coins || 0, boosters: r.boosters || 0, rank: r.rank || 0 };
  });
  res.status(200).json({ ok: true, body: result });
}

function nowTs() {
  return parseInt(Date.now() / 1000, 10);
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}