// Детерминированная логика «слотов» события, как в текущем клиенте, но по серверному
// времени. eventId = номер слота. Событие активно, пока (now % slotLen) < duration.
// slotLen = duration + cooldown. Это даёт авто-события без ручного создания.

export function eventSlot(now, durationMs, cooldownMs) {
  const slotLen = durationMs + cooldownMs;
  return { slot: Math.floor(now / slotLen), slotLen };
}

export function slotTimes(slot, slotLen, durationMs) {
  return {
    activeStart: slot * slotLen,
    activeEnd: slot * slotLen + durationMs,
    nextStart: (slot + 1) * slotLen,
  };
}

// Инфо о текущем событии (server time = источник истины).
export function currentEventInfo(now, cfg) {
  const { slot, slotLen } = eventSlot(now, cfg.event_duration_ms, cfg.cooldown_ms);
  const ts = slotTimes(slot, slotLen, cfg.event_duration_ms);
  const active = now < ts.activeEnd;
  // Событие, которое уже закончилось и ждёт финализации (для cron/ленивой проверки).
  // Если сейчас активно — предыдущий слот; иначе текущий слот, который только что закрылся.
  const finalizeEventId = active ? slot - 1 : slot;
  return {
    eventId: slot,
    active,
    activeStart: ts.activeStart,
    activeEnd: ts.activeEnd,
    nextStart: ts.nextStart,
    now,
    finalizeEventId,
  };
}

// Может ли игрок начать полную попытку: до конца события осталось >= attempt_ms.
export function canStartAttempt(now, info, cfg) {
  if (!info.active) return { ok: false, reason: "event_not_active" };
  const remaining = info.activeEnd - now;
  if (remaining < cfg.attempt_ms) return { ok: false, reason: "not_enough_time" };
  return { ok: true, remaining };
}