// Общий доступ к Firestore через Admin SDK (серверные права).
// Креды: Vercel env-переменная GOOGLE_CREDENTIALS_JSON (содержимое service account .json),
// либо GOOGLE_APPLICATION_CREDENTIALS (путь). Если не заданы — полагаемся на Application Default Credentials.
import { Firestore } from "@google-cloud/firestore";

let db = null;
let configCache = null;
let configCacheAt = 0;

export function initDb() {
  if (db) return db;
  const json = process.env.GOOGLE_CREDENTIALS_JSON;
  if (json) {
    const creds = JSON.parse(json);
    db = new Firestore({ projectId: creds.project_id, credentials: creds });
  } else {
    db = new Firestore();
  }
  return db;
}

// Конфиг ивента (duration/attempt/cooldown/lives/prizes) из config/event_rules.
// Кэшируем на 60 c, чтобы не читать Firestore на каждый запрос.
export async function getEventConfig() {
  const fire = initDb();
  const now = Date.now();
  if (configCache && now - configCacheAt < 60000) return configCache;
  const snap = await fire.doc("config/event_rules").get();
  const def = {
    event_duration_ms: 2 * 60 * 60 * 1000, // 2 часа
    attempt_ms: 3 * 60 * 1000,             // 3 минуты
    cooldown_ms: 0,                        // перерыв между ивентами
    max_lives: 5,                          // фиксированных жизней на ивент (вариант B)
    prizes: {
      1: { coins: 100, boosters: 5 },
      2: { coins: 60, boosters: 3 },
      3: { coins: 30, boosters: 2 },
    },
    participation_prize: { coins: 5, boosters: 1 },
  };
  if (snap.exists) {
    const d = snap.data();
    configCache = Object.assign(def, {
      prizes: Object.assign(def.prizes, d.prizes || {}),
      participation_prize: Object.assign(def.participation_prize, d.participation_prize || {}),
      ...d,
    });
  } else {
    configCache = def;
  }
  configCacheAt = now;
  return configCache;
}

// Сбросить кэш конфига при ручном изменении (для cron).
export function resetConfigCache() {
  configCache = null;
}
