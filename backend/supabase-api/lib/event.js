// Deterministic event slots by SERVER time.
// eventId = slot number; event is active while (now % slotLen) < duration.
// Removes manual event creation and clock drift between instances.
export const CFG = {
  event_duration_ms: 2 * 60 * 60 * 1000, // 2 hours
  cooldown_ms: 0,                        // pause between events
  attempt_ms: 3 * 60 * 1000,             // round: 3 minutes
  max_lives: 5,
  prizes: {
    1: { coins: 100, boosters: 5 },
    2: { coins: 60, boosters: 3 },
    3: { coins: 30, boosters: 2 },
  },
  participation_prize: { coins: 5, boosters: 1 },
  max_score: 60000,
  max_actions: 400,
  life_cost: 30,
};

export function currentEventInfo(now) {
  const slotLen = CFG.event_duration_ms + CFG.cooldown_ms;
  const slot = Math.floor(now / slotLen);
  return {
    eventId: slot,
    active: (now % slotLen) < CFG.event_duration_ms,
    activeStart: slot * slotLen,
    activeEnd: slot * slotLen + CFG.event_duration_ms,
    nextStart: (slot + 1) * slotLen,
    now,
  };
}
