// GET/POST /api/event/info
// Возвращает состояние текущего события + мой статус (живни, лучший счёт) + мои награды.
import { initDb } from "../../lib/db.js";
import { getEventConfig } from "../../lib/db.js";
import { currentEventInfo } from "../../lib/event.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  let body = {};
  if (req.method === "GET") { body = req.query; }
  else if (typeof req.body === "object" && req.body !== null) { body = req.body; }
  else { try { body = JSON.parse(req.body || "{}"); } catch (e) {} }

  const fire = initDb();
  const cfg = await getEventConfig();
  const now = Date.now();
  const info = currentEventInfo(now, cfg);

  let my = null;
  const uid = String(body.vk_user_id || "");
  if (uid) {
    try {
      const pid = fire.doc(`events/${info.eventId}/players/${uid}`);
      const pSnap = await pid.get();
      if (pSnap.exists) my = pSnap.data();
    } catch (e) {
      // ошибка чтения профиля игрока — не критично, lives всё равно отдадим
    }
    // жизни на текущий ивент
    let lives = cfg.max_lives;
    try {
      const lSnap = await fire.doc(`lives/${uid}`).get();
      if (lSnap.exists && lSnap.data().event_id === info.eventId) {
        lives = lSnap.data().lives;
      }
    } catch (e) {
      // ошибка чтения жизней — по умолчанию полный запас
    }
    if (!my) my = {};
    my.lives = lives;
    my.max_lives = cfg.max_lives;
  }

  // Мои награды за предыдущие события (последние несколько).
  // Обёрнуто в try/catch: collectionGroup("rewards") требует составной индекс в Firestore.
  // Если индекса ещё нет — не валим весь endpoint, а просто возвращаем пустой список
  // наград (жизни и статус события всё равно отдаём).
  let rewards = [];
  if (uid) {
    try {
      const rSnap = await fire.collectionGroup("rewards").where("uid", "==", uid).limit(10).get();
      rSnap.forEach((d) => {
        const v = d.data();
        rewards.push({
          eventId: v.event_id, rank: v.rank, coins: v.coins, boosters: v.boosters,
          claimed: !!v.claimed,
        });
      });
    } catch (e) {
      // индекс на rewards/uid отсутствует — игнорируем, награды пока не критичны
    }
  }

  res.status(200).json({
    ok: true,
    body: {
      now: info.now, eventId: info.eventId, active: info.active,
      activeStart: info.activeStart, activeEnd: info.activeEnd, nextStart: info.nextStart,
      finalizeEventId: info.finalizeEventId,
      attempt_ms: cfg.attempt_ms,
      me: my, rewards,
    },
  });
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}