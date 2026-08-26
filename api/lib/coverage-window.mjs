// Where the dataset starts, for two different audiences.
//
// The archive genuinely holds 2026-06-06 onward, and the API says so: a
// customer querying what exists must be told what exists. But collection began
// PART-WAY THROUGH 06-06, so that day and 06-07 are partial — and a marketing
// line that says "since 06-06" invites a buyer to check, find two thin days and
// conclude the coverage claims cannot be trusted. The two dates answer
// different questions, so both are published rather than one being bent:
//
//   firstDay          what the archive contains        (API contract)
//   firstCompleteDay  the first full UTC day           (what we advertise)
//
// Same convention as the public sample repos, which have always started their
// range at the first complete day.

/** First complete UTC day per venue. Collection started mid-day before these. */
export const FIRST_COMPLETE_DAY = Object.freeze({
  polymarket: '2026-06-08', // 06-06 and 06-07 are partial
  predict: '2026-06-13',    // 06-12 is ~66% of the day
});

/** The product as a whole starts when its earliest venue is complete. */
export const PRODUCT_FIRST_COMPLETE_DAY = FIRST_COMPLETE_DAY.polymarket;

/**
 * First UTC day a BACKTEST can use. Different question from the one above.
 *
 * A replay has to know which price stream settled each market, and that answer
 * comes from the market's own `raw.cryptoMarketConfig.twapLookbackSeconds`.
 * MEASURED: polymarket markets carry it from 2026-08-08 and not before —
 * 0/98 on 08-05, 08-06 and 08-07, 98/98 on 08-08. Days before that decode
 * fine and then drop every market ("settlement stream could not be resolved"),
 * so a run over them burns twenty minutes and refunds in full.
 *
 * WHY NOT INFER THE OLD RULE. It was tried, with the archive as the judge:
 * every settled market records its strike and its actual outcome, so a
 * candidate rule can be scored against reality. "Raw chainlink price at close"
 * reproduces 97.9–100% of settled markets across three sampled days — close,
 * and therefore worse than useless: a table built on it would decide about
 * 1.5% of markets the wrong way, in reports that look completely ordinary.
 * The TWAP hypotheses could not even be tested, because a recomputed TWAP
 * failed its control against the archived one (differing by up to $57, enough
 * to settle a market the other way). Owner's call, 2026-08-25: offer only the
 * days the archive can answer for.
 *
 * This is DATA COVERAGE, not a limit — `/v1/backtest/capacity` reports it and
 * the page offers only what it can deliver.
 */
export const FIRST_BACKTEST_DAY = Object.freeze({
  polymarket: '2026-08-08',
  // Predict settles off fields carried on the market row itself rather than a
  // separate stream, so it is not affected by the polymarket cutover. Pinned
  // to its first complete day until measured otherwise.
  predict: FIRST_COMPLETE_DAY.predict,
});

/**
 * The days a backtest may actually be sold on a venue.
 *
 * Both floors apply: a day has to be complete AND has to be one the archive
 * can attribute a settlement stream to.
 */
export function backtestDayList(days, venue) {
  const v = String(venue ?? '').toLowerCase();
  const floor = [
    FIRST_COMPLETE_DAY[v] ?? PRODUCT_FIRST_COMPLETE_DAY,
    FIRST_BACKTEST_DAY[v] ?? FIRST_BACKTEST_DAY.polymarket,
  ].sort().pop();
  return completeDayList(days, floor);
}

/**
 * The advertised window over a sorted list of archived days.
 *
 * Counts from the first complete day, never from the first day held — quoting
 * "69 days since 06-06" and "since 06-08" in the same breath is the kind of
 * inconsistency a buyer notices before anything else.
 *
 * @param {string[]} days sorted ascending
 */
/**
 * The days a run may actually be sold, out of everything the archive holds.
 *
 * One definition, used by both the advertised count and the billable window.
 * A partial day is real data and the API says it exists, but a full credit buys
 * a market-DAY — charging one for a day collection only caught part of is the
 * same gap-must-reduce-billing rule the quote already follows, pointed at the
 * front of the archive instead of the middle.
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
    // Length of the list, not a date subtraction: a gap in the archive must
    // reduce this, and calendar arithmetic would paper over it.
    completeDays: full.length,
  };
}
