// Ленивая (ленивая) регенерация жизней по времени — без крон-задачи.
// Жизни игрока хранятся в lives/<uid>={lives, event_id, updated_at}.
// При каждом обращении (info/start/buy) пересчитываем, сколько жизней
// накопилось с момента последнего обновления, и обновляем счётчик.
//
// Тариф Hobby Vercel не позволяет cron, поэтому реген делаем «по запросу»:
// игрок зашёл -> жизни подросли согласно прошедшему времени.

const REGEN_MS = 5 * 60 * 1000; // +1 жизнь каждые 5 минут

// Вернуть количество жизней с учётом ленивого регена и записать обновлённый
// счётчик в базу. Если документа нет — полный запас.
// Возвращает { lives, max_lives, regenerated }.
export async function getLives(fire, uid, eventId, max_lives) {
  const ref = fire.doc(`lives/${uid}`);
  const snap = await ref.get();
  const now = Date.now();
  let lives = max_lives;
  let updated = now;
  let regenerated = 0;

  if (snap.exists) {
    const d = snap.data();
    const sameEvent = d.event_id === eventId;
    if (sameEvent) {
      lives = typeof d.lives === "number" ? d.lives : max_lives;
      const prev = typeof d.updated_at === "number" ? d.updated_at : now;
      if (lives < max_lives && prev <= now) {
        const gained = Math.floor((now - prev) / REGEN_MS);
        if (gained > 0) {
          regenerated = gained;
          lives = Math.min(max_lives, lives + gained);
          updated = prev + gained * REGEN_MS; // сдвигаем точку отсчёта на использованный реген
        }
      }
    } else {
      // новый ивент — полный запас
      lives = max_lives;
    }
  }

  // Пишем обратно (чтобы реген не накручивался многократно по старому времени)
  await ref.set({ event_id: eventId, lives, updated_at: updated });

  return { lives, max_lives, regenerated };
}

// Списать 1 жизнь (если есть) и вернуть новое значение. Атомарно через транзакцию.
// Используется при старте попытки (событие) и при проигрыше в кампании.
export async function spendLife(fire, uid, eventId, max_lives) {
  const ref = fire.doc(`lives/${uid}`);
  const now = Date.now();
  let ok = false;
  let lives = max_lives;

  // Сначала нагоним ленивый реген в рамках транзакции.
  await fire.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const sameEvent = snap.exists && snap.data().event_id === eventId;
    let cur = max_lives;
    let updated = now;
    if (snap.exists && sameEvent) {
      cur = typeof snap.data().lives === "number" ? snap.data().lives : max_lives;
      updated = typeof snap.data().updated_at === "number" ? snap.data().updated_at : now;
      if (cur < max_lives && updated <= now) {
        const gained = Math.floor((now - updated) / REGEN_MS);
        if (gained > 0) {
          cur = Math.min(max_lives, cur + gained);
          updated = updated + gained * REGEN_MS;
        }
      }
    } else {
      updated = now;
    }

    if (cur <= 0) {
      tx.set(ref, { event_id: eventId, lives: 0, updated_at: updated });
      ok = false;
      return;
    }
    cur -= 1;
    tx.set(ref, { event_id: eventId, lives: cur, updated_at: updated });
    lives = cur;
    ok = true;
  });

  return { ok, lives, max_lives };
}
