// POST /api/event/rewards
// Мои полученные/неполученные награды за событие(и).
// Body: { vk_user_id, event_id? }
import { initDb, getEventConfig } from "../../lib/db.js";
import { currentEventInfo } from "../../lib/event.js";

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
  const info = currentEventInfo(Date.now(), cfg);

  if (body.event_id != null) {
    // награда конкретного события
    const ref = fire.doc(`events/${body.event_id}/rewards/${uid}`);
    const snap = await ref.get();
    const v = snap.exists ? snap.data() : null;
    return res.status(200).json({ ok: true, body: v ? { ...v, event_id: body.event_id } : null });
  }

  // последние несколько событий
  const rSnap = await fire.collectionGroup("rewards").where("uid", "==", uid).limit(20).get();
  const rewards = [];
  rSnap.forEach((d) => {
    const v = d.data();
    rewards.push({ event_id: v.event_id, rank: v.rank, coins: v.coins, boosters: v.boosters, claimed: !!v.claimed });
  });
  rewards.sort((a, b) => b.event_id - a.event_id);
  res.status(200).json({ ok: true, body: rewards });
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}