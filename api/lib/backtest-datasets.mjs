// Translating between what a strategy asks for and what the archive holds.
//
// The SDK's dataset names are a product surface: `book`, `trades`, `settlement`.
// The archive's are a storage detail: `price_change`, `orderbook`,
// `last_trade_price`, `chainlink-twap-60s`. Keeping the two apart is what lets
// the archive be reorganised without breaking a manifest a customer wrote three
// months ago.
//
// The interesting one is `settlement`, which is not a stored stream at all.

import { classifyPath } from './data-taxonomy.mjs';
import {
  CAPTURE_WINDOWS, DERIVED_DATASETS, KNOWN_DATASETS, BacktestRejection,
} from './backtest-contract.mjs';

/**
 * SDK dataset name -> the archive dataset names that satisfy it, per venue.
 *
 * `book` and `trades` are one concept each to a strategy but two different
 * trees per venue: Polymarket publishes full snapshots plus deltas, Predict.fun
 * publishes a single `orderbook` tree. A strategy that declares `book` gets
 * whatever that venue actually has, which is the point of naming it `book`.
 */
const ARCHIVE_DATASETS = Object.freeze({
  polymarket: Object.freeze({
    prices: Object.freeze(['prices']),
    twap30s: Object.freeze(['twap30s']),
    twap60s: Object.freeze(['twap60s']),
    book: Object.freeze(['book', 'price_change']),
    trades: Object.freeze(['last_trade_price']),
    markets: Object.freeze(['markets']),
  }),
  predict: Object.freeze({
    prices: Object.freeze(['prices']),
    twap30s: Object.freeze(['twap30s']),
    twap60s: Object.freeze(['twap60s']),
    book: Object.freeze(['orderbook']),
    trades: Object.freeze(['last_trade_price']),
    markets: Object.freeze(['markets']),
  }),
});

/**
 * `markets` is always fed, whether or not a strategy declares it.
 *
 * Not a convenience: on_market_open carries the strike and on_settle carries
 * the official outcome, both of which live in the markets tree, and the
 * settlement-stream resolution below reads twapLookbackSeconds from the same
 * place. A run without it could not identify which stream a market settled on,
 * which is the one thing this product exists to get right.
 */
export const ALWAYS_FED = Object.freeze(['markets']);

/**
 * Which captured stream a single market settled on.
 *
 * Read from the market's OWN config, never inferred from its date. The venues
 * moved 5-minute markets onto a 30-second TWAP and then onto 60, while
 * 15-minute markets went straight to 60 — so any date-based rule is wrong for
 * whole classes of market inside the transition, and wrong quietly. The market
 * record states its own lookback; that is the answer.
 *
 * Fail-closed on anything unrecognised. A market whose config we cannot read is
 * not guessed at: the caller gets null and must reject the market-day rather
 * than feed a strategy a stream the market did not settle on.
 *
 * @param {object} market a row from the markets dataset
 * @returns {'prices'|'twap30s'|'twap60s'|null}
 */
export function resolveSettlementStream(market) {
  const cfg = market?.raw?.cryptoMarketConfig ?? market?.cryptoMarketConfig ?? null;
  // No config object at all is a record we could not read, NOT evidence of the
  // pre-TWAP regime. An earlier version returned 'prices' here and that was
  // fail-OPEN in the worst possible place: every market whose metadata we
  // failed to parse would have been fed the 1 Hz stream and silently reported
  // as if that were what it settled on. A dropped market-day is visible in
  // coverage and costs the customer nothing; a wrong settlement stream is
  // invisible and makes the whole report a lie.
  if (!cfg || typeof cfg !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(cfg, 'twapLookbackSeconds')) return null;

  const lookback = cfg.twapLookbackSeconds;
  // An explicit null or 0 IS a positive statement: this market settled on the
  // instantaneous stream. That is different from the field being absent.
  if (lookback === null || lookback === 0) return 'prices';
  if (lookback === 30) return 'twap30s';
  if (lookback === 60) return 'twap60s';
  return null;
}

/**
 * Is a captured stream available for this venue on this day?
 *
 * Both ends are inclusive and `to: null` means "still capturing".
 */
export function isCaptured(venue, dataset, day) {
  const w = CAPTURE_WINDOWS[venue]?.[dataset];
  if (!w) return false;
  if (day < w.from) return false;
  if (w.to && day > w.to) return false;
  return true;
}

/**
 * Every day in [from, to] on which a captured stream is unavailable.
 *
 * Returned rather than counted so E_COVERAGE can name the range that failed —
 * "twap60s is not captured before 2026-08-07" is actionable, "coverage error"
 * is not.
 */
export function uncapturedRange(venue, dataset, from, to) {
  const w = CAPTURE_WINDOWS[venue]?.[dataset];
  if (!w) return { from, to };
  const badFrom = from < w.from ? from : null;
  const badTo = badFrom ? (to < w.from ? to : prevDay(w.from)) : null;
  if (badFrom) return { from: badFrom, to: badTo };
  if (w.to && to > w.to) return { from: nextDay(w.to), to };
  return null;
}

function shiftDay(day, delta) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
const prevDay = (d) => shiftDay(d, -1);
const nextDay = (d) => shiftDay(d, 1);

/**
 * Check a manifest's declared datasets against a venue and date range.
 *
 * `settlement` is exempt: it resolves per market to whatever that market
 * settled on, so it is available wherever the archive is — that is the entire
 * reason to prefer it, and why the docs recommend it.
 *
 * Throws BacktestRejection(E_COVERAGE) on the first stream that is not
 * available for the whole range, naming the gap.
 */
export function assertCoverage({ datasets, venue, from, to }) {
  for (const ds of datasets ?? []) {
    if (ds === 'settlement') continue;
    if (DERIVED_DATASETS[ds]) {
      // A derived stream is a function of one we hold, so its availability is
      // the SOURCE stream's availability, not its own.
      const src = DERIVED_DATASETS[ds].from;
      const gap = uncapturedRange(venue, src, from, to);
      if (gap) {
        throw new BacktestRejection('E_COVERAGE',
          `${ds} is derived from ${src}, which is not captured for ${gap.from}..${gap.to ?? gap.from} on ${venue}`,
          { dataset: ds, derivedFrom: src, venue, gap });
      }
      continue;
    }
    const gap = uncapturedRange(venue, ds, from, to);
    if (gap) {
      const w = CAPTURE_WINDOWS[venue]?.[ds];
      throw new BacktestRejection('E_COVERAGE',
        `${ds} is not captured for ${gap.from}..${gap.to ?? gap.from} on ${venue}`
        + (w ? ` (captured from ${w.from}${w.to ? ` to ${w.to}` : ''})` : '')
        + '. Use settlement, or a :derived stream if you specifically want today\'s rules on older dates.',
        { dataset: ds, venue, gap, capturedFrom: w?.from ?? null, capturedTo: w?.to ?? null });
    }
  }
}

/**
 * The archive dataset names a run must fetch for a given manifest.
 *
 * `settlement` expands to every stream that could be authoritative for some
 * market in the range: the resolution is per market and is not known until the
 * markets metadata has been read, so the worker fetches the union and the
 * engine picks per market. Streams outside their capture window are dropped
 * rather than requested — no market in that window can have settled on them.
 */
export function archiveDatasetsFor({ datasets, venue, from, to }) {
  const wanted = new Set();
  for (const ds of [...(datasets ?? []), ...ALWAYS_FED]) {
    if (ds === 'settlement') {
      for (const s of ['prices', 'twap30s', 'twap60s']) {
        if (!uncapturedRange(venue, s, from, to) || isCaptured(venue, s, to)) wanted.add(s);
      }
      continue;
    }
    const base = DERIVED_DATASETS[ds]?.from ?? ds;
    wanted.add(base);
  }
  const out = new Set();
  const map = ARCHIVE_DATASETS[venue] ?? {};
  for (const w of wanted) for (const a of map[w] ?? []) out.add(a);
  return [...out].sort();
}

/**
 * Does an archived file belong to this run's scope?
 *
 * Runs on top of the entitlement gate, never instead of it: this decides what a
 * paid-for run is FED, while scope.mjs decides what a customer may DOWNLOAD.
 * A backtest reads files the submitter has not bought, which is the product —
 * so this filter must never be mistaken for an authorisation check.
 */
export function fileMatchesRun(filePath, { venue, assets, archiveDatasets }) {
  const meta = classifyPath(filePath);
  if (meta.venue !== venue) return false;
  if (!archiveDatasets.includes(meta.dataset)) return false;
  // Venue-wide datasets (markets) carry no asset and are always in scope.
  if (meta.asset && assets?.length && !assets.includes(meta.asset)) return false;
  return true;
}

/** Validate a declared dataset list, returning it normalised. */
export function normalizeDatasets(list) {
  if (!Array.isArray(list) || list.length === 0) {
    throw new BacktestRejection('E_MANIFEST', 'datasets must be a non-empty array');
  }
  const out = [];
  for (const raw of list) {
    const ds = String(raw ?? '').trim();
    if (!KNOWN_DATASETS.includes(ds) && !DERIVED_DATASETS[ds]) {
      throw new BacktestRejection('E_MANIFEST',
        `unknown dataset ${JSON.stringify(ds)}; known: ${[...KNOWN_DATASETS, ...Object.keys(DERIVED_DATASETS)].join(', ')}`);
    }
    if (!out.includes(ds)) out.push(ds);
  }
  return out;
}
