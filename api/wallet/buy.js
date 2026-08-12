// POST /api/wallet/buy
// Покупка предмета за серверные монеты.
// Body: { vk_user_id, item: "booster" }
// Списывает монеты серверно и учитывает покупку (клиент хранит локальный счётчик бустов,
// но трата монет — серверная и защищена).
import { initDb } from "../../lib/db.js";

const ITEMS = {
  booster: { cost: 30 },
};

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  let body = {};
  if (typeof req.body === "object" && req.body !== null) { body = req.body; }
  else { try { body = JSON.parse(req.body || "{}"); } catch (e) {} }

  const uid = String(body.vk_user_id || "");
  if (!uid) return res.status(400).json({ ok: false, error: "no_uid" });
  const item = String(body.item || "");
  if (!ITEMS[item]) return res.status(400).json({ ok: false, error: "bad_item" });
  const cost = ITEMS[item].cost;

  const fire = initDb();
  const uRef = fire.doc(`users/${uid}`);
  const now = Date.now();

  try {
    const result = await fire.runTransaction(async (tx) => {
      const uSnap = await tx.get(uRef);
      const coins = uSnap.exists ? (uSnap.data().coins || 0) : 0;
      if (coins < cost) return { ok: false, reason: "not_enough_coins", coins };
      const coinsAfter = coins - cost;
      tx.set(uRef, { coins: coinsAfter, updated_at: now });
      return { ok: true, coins: coinsAfter };
    });
    if (!result.ok) return res.status(400).json({ ok: false, error: result.reason, coins: result.coins });
    res.status(200).json({ ok: true, body: { item, coins: result.coins } });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}