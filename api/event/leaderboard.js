// POST /api/event/leaderboard
// Возвращает ТОП-N и (опционально) мой счёт/место.
// Body: { event_id?, vk_user_id?, limit? }
import { initDb, getEventConfig } from "../../lib/db.js";
import { currentEventInfo } from "../../lib/event.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  let body = {};
  try { body = req.method === "GET" ? req.query : JSON.parse(req.body || "{}"); } catch (e) {}

  const fire = initDb();
  const cfg = await getEventConfig();
  const now = Date.now();
  const info = currentEventInfo(now, cfg);
  const eventId = body.event_id != null ? parseInt(body.event_id, 10) : info.eventId;
  if (!Number.isFinite(eventId)) return res.status(400).json({ ok: false, error: "bad_event" });

  const limit = Math.min(50, Math.max(1, parseInt(body.limit || "20", 10)));
  const snap = await fire.collection(`events/${eventId}/players`)
    .orderBy("best_score", "desc").limit(limit).get();
  const rows = [];
  let myPos = -1, myScore = 0;
  const uid = String(body.vk_user_id || "");
  let i = 0;
  snap.forEach((d) => {
    const v = d.data();
    rows.push({
      vk_user_id: d.id, name: v.name || "?", avatar: v.avatar || "",
      score: v.best_score || 0,
    });
    if (uid && d.id === uid) { myPos = i + 1; myScore = v.best_score || 0; }
    i++;
  });

  // Если я не в топе — отдельный запрос моего счёта
  if (uid && myPos < 0) {
    const mySnap = await fire.doc(`events/${eventId}/players/${uid}`).get();
    if (mySnap.exists) myScore = mySnap.data().best_score || 0;
  }

  res.status(200).json({ ok: true, body: { eventId, rows, me: { uid, score: myScore, pos: myPos } } });
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}