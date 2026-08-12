// POST /api/event/buy
// Покупка попытки (1 жизнь) за монеты из серверного кошелька.
// Body: { vk_user_id }
import { initDb, getEventConfig } from "../../lib/db.js";
import { currentEventInfo } from "../../lib/event.js";
import { getLives } from "../../lib/lives.js";

const LIFE_COST_COINS = 30;

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

  const uRef = fire.doc(`users/${uid}`);
  const lRef = fire.doc(`lives/${uid}`);

  try {
    // Ленивый реген перед покупкой (чтобы не накручивать выше максимума)
    const cur = await getLives(fire, uid, info.eventId, cfg.max_lives);
    if (cur.lives >= cfg.max_lives) {
      return res.status(200).json({ ok: true, body: { lives: cur.lives, max_lives: cfg.max_lives, added: 0, full: true } });
    }

    const result = await fire.runTransaction(async (tx) => {
      const uSnap = await tx.get(uRef);
      const coins = uSnap.exists ? (uSnap.data().coins || 0) : 0;
      if (coins < LIFE_COST_COINS) {
        return { ok: false, reason: "not_enough_coins", coins };
      }
      // Ещё раз читаем жизни внутри транзакции (актуально после параллельных запросов)
      const lSnap = await tx.get(lRef);
      const sameEvent = lSnap.exists && lSnap.data().event_id === info.eventId;
      let lives = cfg.max_lives;
      if (lSnap.exists && sameEvent) {
        lives = typeof lSnap.data().lives === "number" ? lSnap.data().lives : cfg.max_lives;
      }
      if (lives >= cfg.max_lives) {
        return { ok: true, added: 0, lives, full: true };
      }
      lives += 1;
      let coinsAfter = coins - LIFE_COST_COINS;
      tx.set(uRef, { coins: coinsAfter, updated_at: now });
      tx.set(lRef, { event_id: info.eventId, lives, updated_at: now });
      return { ok: true, added: 1, lives, full: false, coins: coinsAfter };
    });

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.reason, coins: result.coins });
    }
    res.status(200).json({
      ok: true,
      body: { lives: result.lives, max_lives: cfg.max_lives, added: result.added, full: result.full, coins: result.coins ?? 0 },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
