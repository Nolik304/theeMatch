// Античит: проверка правдоподобности результата попытки.
// PROTIP: это не полная серверная симуляция, а «грубая сетка» — отсекает очевидные
// подделки (накрученный score, невозможная скорость, слишком короткая/длинная попытка).
// score передаётся игроком; сервер проверяет, что он не абсурден относительно
// количества действий и времени.

export function validateScore({ score, duration, waves, moves, combos, destroyed }, cfg) {
  const errors = [];
  const attemptMs = cfg.attempt_ms;

  // 1. Попытка должна длиться ~3 минуты ± допустимая погрешность.
  //    duration_ms от клиента. Разрешаем небольшие отклонения (тайминг/фреймы).
  if (!Number.isFinite(+duration) || +duration <= 0) {
    errors.push("bad_duration");
  } else {
    const d = +duration;
    const minMs = attemptMs * 0.85;
    const maxMs = attemptMs * 1.5;
    if (d < minMs || d > maxMs) errors.push("duration_out_of_range:" + Math.round(d));
  }

  // 2. score не может быть отрицательным.
  if (!Number.isFinite(+score) || +score < 0) {
    errors.push("bad_score");
  }

  // 3. Максимально правдоподобный score за 3 минуты.
  //    В игре очки растут от числа удалённых фишек × множитель (до x3.0).
  //    Реалистичный потолок ~ 3000-6000 очков. Берём с запасом.
  const MAX_SCORE = cfg.max_score || 60000;
  if (+score > MAX_SCORE) errors.push("score_above_cap:" + Math.round(+score));

  // 4. «Скорость»: очки на действие. Если actions==0, не проверяем (неизвестно).
  const actions = Math.max(0, (+moves || 0) + (+combos || 0) + (+waves || 0));
  if (actions > 0) {
    const perAction = +score / actions;
    if (perAction > 5000) errors.push("score_per_action_impossible:" + Math.round(perAction));
  }

  // 5. Не больше N действий за 3 минуты (физический потолок ~ 1 ход/500мс → 360).
  const MAX_ACTIONS = (cfg.max_actions || 400) * (attemptMs / (3 * 60 * 1000));
  if (actions > MAX_ACTIONS) errors.push("too_many_actions:" + Math.round(actions));

  return { ok: errors.length === 0, errors };
}