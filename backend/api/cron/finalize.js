// Cron: финализация закончившихся событий.
// Запускается по расписанию (см. vercel.json). Проходит по последним M событиям,
// которые activeEnd <= now и ещё не финализированы, определяет места и пишет rewards.
// Idempotent: помечает events/{id}.status = finalized только один раз (runTransaction).
import { initDb, getEventConfig, resetConfigCache } from "../../lib/db.js";
import { currentEventInfo } from "../../lib/event.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  const fire = initDb();
  const cfg = await getEventConfig();
  const now = Date.now();
  const info = currentEventInfo(now, cfg);

  // Идём назад от текущего слота, финализируем всё, что созрело.
  let finalized = 0;
  const LOOKBACK = 5;
  for (let step = 1; step <= LOOKBACK; step++) {
    const eid = info.eventId - step;
    const ts = { activeEnd: (eid + 1) * (cfg.event_duration_ms + cfg.cooldown_ms) - cfg.cooldown_ms };
    if (ts.activeEnd > now) break; // ещё не закончилось
    const did = await finalizeOne(fire, eid);
    if (did) finalized++;
  }

  resetConfigCache(); // на случай правки конфига снаружи
  res.status(200).json({ ok: true, body: { finalized } });
}

async function finalizeOne(fire, eventId) {
  const eventRef = fire.doc(`events/${eventId}`);
  let done = false;
  try {
    await fire.runTransaction(async (tx) => {
      const eSnap = await tx.get(eventRef);
      if (eSnap.exists && eSnap.data().status === "finalized") { done = true; return; }

      const players = await tx.get(fire.collection(`events/${eventId}/players`).orderBy("best_score", "desc").limit(200));
      const ranked = [];
      let idx = 0;
      players.forEach((d) => {
        const v = d.data();
        ranked.push({ uid: d.id, best: v.best_score || 0, name: v.name || "", avatar: v.avatar || "" });
      });
      // сортировка уже по best_score desc; назначаем места
      ranked.forEach((p, i) => {
        p.rank = i + 1;
        const reward = rankPrize(p.rank, cfg);
        if (reward) {
          const rRef = fire.doc(`events/${eventId}/rewards/${p.uid}`);
          tx.set(rRef, { uid: p.uid, event_id: eventId, rank: p.rank, ...reward, claimed: false, granted_at: nowTs() }, { merge: true });
        }
      });

      // у кого вообще был прогресс, но вне топ-200 — приз за участие
      const allPlayers = await tx.get(fire.collection(`events/${eventId}/players`));
      const seen = new Set(ranked.map((r) => r.uid));
      allPlayers.forEach((d) => {
        if (seen.has(d.id)) return;
        idx++;
        const reward = rankPrize(idx, cfg, true);
        if (reward) {
          const rRef = fire.doc(`events/${eventId}/rewards/${d.id}`);
          tx.set(rRef, { uid: d.id, event_id: eventId, rank: idx, ...reward, claimed: false, granted_at: nowTs() }, { merge: true });
        }
      });

      tx.set(eventRef, {
        status: "finalized", finalized_at: nowTs(),
        winners: ranked.length, rewards_granted: ranked.length,
      }, { merge: true });
      done = true;
    });
  } catch (e) {
    // транзакция могла конфликтовать с другим cron-инстансом — пропускаем, пишем эхо
    console.error("finalize err", eventId, String(e));
  }
  return done;
}

function rankPrize(rank, cfg, participation) {
  if (participation) return cfg.participation_prize || null;
  if (rank <= 3) return cfg.prizes[rank] || null;
  return cfg.participation_prize || null; // 4+ → приз за участие
}

function nowTs() {
  return parseInt(Date.now() / 1000, 10);
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// Для прямого вызова по cron (без безопасного 'auth') — защитим простым ключом.
export const config = {};