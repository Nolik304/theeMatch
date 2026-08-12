// POST /api/wallet/earn
// Начисление монет за первое прохождение уровня (серверно, честно).
// Body: { vk_user_id, level, stars }
// Сервер сам вычисляет награду по полосе уровня и хранит факт первого прохождения,
// поэтому клиент не может накрутить монеты повторными запросами.
import { initDb } from "../../lib/db.js";

const BANDS = [
  { from: 1,   to: 50 },
  { from: 51,  to: 150 },
  { from: 151, to: 300 },
  { from: 301, to: 400 },
  { from: 401, to: 500 },
  { from: 501, to: 800 },
];

function bandIndex(level) {
  for (let i = 0; i < BANDS.length; i++) {
    if (level >= BANDS[i].from && level <= BANDS[i].to) return i;
  }
  return BANDS.length - 1;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  let body = {};
  if (typeof req.body === "object" && req.body !== null) { body = req.body; }
  else { try { body = JSON.parse(req.body || "{}"); } catch (e) {} }

  const uid = String(body.vk_user_id || "");
  if (!uid) return res.status(400).json({ ok: false, error: "no_uid" });
  const level = parseInt(body.level || "0", 10);
  const stars = Math.min(3, Math.max(1, parseInt(body.stars || "1", 10)));
  if (!Number.isFinite(level) || level < 1) return res.status(400).json({ ok: false, error: "bad_level" });

  const fire = initDb();
  const uRef = fire.doc(`users/${uid}`);
  const now = Date.now();

  try {
    const result = await fire.runTransaction(async (tx) => {
      const uSnap = await tx.get(uRef);
      const data = uSnap.exists ? uSnap.data() : {};
      const coins = data.coins || 0;
      const seen = data.seen_levels || {};   // { level: stars }
      const prevStars = seen[String(level)] || 0;

      // Начисляем только первое прохождение (или улучшение звёзд не даёт монет повторно)
      let earned = 0;
      if (prevStars === 0) {
        earned = bandIndex(level) + 1 + stars;
        if (level === 499) earned += 500;  // бонус за кампанию
      }
      seen[String(level)] = Math.max(prevStars, stars);
      const coinsAfter = coins + earned;
      tx.set(uRef, { coins: coinsAfter, seen_levels: seen, updated_at: now });
      return { earned, coins: coinsAfter, first: prevStars === 0 };
    });

    res.status(200).json({ ok: true, body: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}