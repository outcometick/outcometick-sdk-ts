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
 * The advertised window over a sorted list of archived days.
 *
 * Counts from the first complete day, never from the first day held — quoting
 * "69 days since 06-06" and "since 06-08" in the same breath is the kind of
 * inconsistency a buyer notices before anything else.
 *
 * @param {string[]} days sorted ascending
 */
export function completeWindow(days, firstComplete = PRODUCT_FIRST_COMPLETE_DAY) {
  const full = (days ?? []).filter((d) => d >= firstComplete);
  return {
    firstCompleteDay: full[0] ?? null,
    // Length of the list, not a date subtraction: a gap in the archive must
    // reduce this, and calendar arithmetic would paper over it.
    completeDays: full.length,
  };
}
