import { CFG } from "./event.js";

// Anti-cheat plausibility grid (ported from the old Vercel backend):
// rejects inflated scores, impossible speed and too-short/too-long rounds.
export function validateScore({ score, duration, waves, moves, combos, destroyed }) {
  const errors = [];
  const s = +score;
  const d = +duration;

  if (!Number.isFinite(s) || s < 0) errors.push("bad_score");
  else if (s > (CFG.max_score || 60000)) errors.push("score_above_cap:" + Math.round(s));

  if (!Number.isFinite(d) || d <= 0) errors.push("bad_duration");
  else if (d < CFG.attempt_ms * 0.85 || d > CFG.attempt_ms * 1.5)
    errors.push("duration_out_of_range:" + Math.round(d));

  const actions = Math.max(0, (+moves || 0) + (+combos || 0) + (+waves || 0));
  if (actions > 0 && s / actions > 5000) errors.push("score_per_action_impossible");
  if (actions > (CFG.max_actions || 400)) errors.push("too_many_actions:" + Math.round(actions));

  return { ok: errors.length === 0, errors };
}
