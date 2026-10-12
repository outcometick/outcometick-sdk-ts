// firstDay includes partial collection days. firstCompleteDay marks the first
// full UTC day used for complete-day counts.

/** First complete UTC day per venue. Collection started mid-day before these. */
export const FIRST_COMPLETE_DAY = Object.freeze({
  polymarket: '2026-06-08', // 06-06 and 06-07 are partial
  predict: '2026-06-13',    // 06-12 is ~66% of the day
});

/**
 * Earliest complete day across venues.
 */
export const PRODUCT_FIRST_COMPLETE_DAY = FIRST_COMPLETE_DAY.polymarket;

/**
 * First usable backtest day. Polymarket requires twapLookbackSeconds for
 * settlement resolution: archive samples had it on 0/98 markets per day
 * on 08-05 through 08-07 and 98/98 on 08-08. Earlier markets decode but
 * cannot resolve settlement. Do not infer old rules: raw-close hypotheses
 * reproduced only 97.9–100% of sampled outcomes, and recomputed TWAPs
 * failed the archived control by up to $57.
 */
export const FIRST_BACKTEST_DAY = Object.freeze({
  polymarket: '2026-08-08',
  // Predict settlement fields are on market rows; use its first complete day.
  predict: FIRST_COMPLETE_DAY.predict,
});

/**
 * Hosted cache window anchored on the last archived day. Worker measurements:
 * about 1.37 GB/day Polymarket and 0.34 GB/day Predict, with 76 GB usable disk
 * (44 average days or 38 peak days). 35 leaves growth headroom.
 * Check capacity and prewarm before increasing the window.
 */
export const BACKTEST_WINDOW_DAYS = 35;

/**
 * Complete archived days after the settlement-metadata floor, restricted
 * to the most recent BACKTEST_WINDOW_DAYS entries.
 */
export function backtestDayList(days, venue) {
  const v = String(venue ?? '').toLowerCase();
  const floor = [
    FIRST_COMPLETE_DAY[v] ?? PRODUCT_FIRST_COMPLETE_DAY,
    FIRST_BACKTEST_DAY[v] ?? FIRST_BACKTEST_DAY.polymarket,
  ].sort().pop();
  return completeDayList(days, floor).slice(-BACKTEST_WINDOW_DAYS);
}

/**
 * Complete-day counts use archive entries rather than elapsed calendar days.
 */
/**
 * Filter from the first complete UTC day, preserving gaps.
 *
 * @param {string[]} days sorted ascending
 */
export function completeDayList(days, firstComplete = PRODUCT_FIRST_COMPLETE_DAY) {
  return (days ?? []).filter((d) => d >= firstComplete);
}

export function completeWindow(days, firstComplete = PRODUCT_FIRST_COMPLETE_DAY) {
  const full = completeDayList(days, firstComplete);
  return {
    firstCompleteDay: full[0] ?? null,
    // Count entries so archive gaps reduce coverage.
    completeDays: full.length,
  };
}
