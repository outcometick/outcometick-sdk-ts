// Turn an archive path into the dimensions a customer actually thinks in:
// venue, dataset, asset, interval. The archive's own layout grew organically
// (three settlement streams, two venues, derived klines) and is not something a
// buyer should have to learn.
//
// Pure and total: every mirrored path must classify, because the API lists
// whatever the catalog holds. Anything unrecognised comes back with
// dataset:'other' and null dimensions rather than being dropped — a file that
// silently disappears from listings is worse than one that is awkward to filter.

import { venueOfPath } from './venue-path.mjs';

/** Asset symbols we collect, longest-first so BNBUSDT matches before BNB. */
const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE', 'ZEC'];

/** Datasets, as a customer would name them. */
export const DATASETS = {
  prices: 'Settlement feed, tick by tick (instantaneous Chainlink stream)',
  twap30s: 'TWAP 30s settlement stream — settled 5-minute markets before they moved to the 60s lookback; still archived daily',
  twap60s: 'TWAP 60s settlement stream — settles both 5-minute and 15-minute markets',
  book: 'Full-depth order-book snapshots',
  price_change: 'Order-book deltas with best bid/ask',
  last_trade_price: 'Every trade print',
  markets: 'Per-market metadata, strike and settlement outcome',
  tick_size_change: 'Tick-size changes',
  orderbook: 'Order-book snapshots (Predict.fun)',
  klines: 'OHLCV candles derived from the settlement feed',
  other: 'Uncategorised',
};

const num = (s) => (s == null ? null : s);

/**
 * @returns {{venue:'polymarket'|'predict', dataset:string, asset:string|null,
 *            interval:string|null, ext:string}}
 */
export function classifyPath(filePath) {
  const p = String(filePath);
  const segs = p.split('/');
  const name = segs[segs.length - 1] ?? '';
  const venue = venueOfPath(p);
  const ext = name.endsWith('.csv.gz') ? 'csv.gz' : name.endsWith('.jsonl.gz') ? 'jsonl.gz' : '';

  const assetOf = (s) => {
    if (!s) return null;
    const up = s.toUpperCase();
    return ASSETS.find((a) => up.startsWith(a)) ?? null;
  };

  // derived/klines/<source>/<ASSET>/<interval>/<file>
  if (segs[0] === 'derived' && segs[1] === 'klines') {
    return { venue, dataset: 'klines', asset: assetOf(segs[3]), interval: num(segs[4]), ext };
  }

  // data/predict-fun/<dataset>/...
  if (segs[1] === 'predict-fun') {
    const ds = segs[2];
    if (ds === 'klines') {
      return { venue, dataset: 'klines', asset: assetOf(segs[3]), interval: num(segs[4]), ext };
    }
    if (ds === 'orderbook') {
      // BTC-5M / BTC-15M / MARKET-<id>
      const m = /^([A-Za-z]+)-(\d+[mMhHdD]|DAILY)$/.exec(segs[3] ?? '');
      return {
        venue,
        dataset: 'orderbook',
        asset: assetOf(m?.[1] ?? segs[3]),
        interval: m ? m[2].toLowerCase() : null,
        ext,
      };
    }
    if (ds === 'prices') return { venue, dataset: 'prices', asset: assetOf(segs[3]), interval: null, ext };
    if (ds === 'markets') return { venue, dataset: 'markets', asset: null, interval: null, ext };
    return { venue, dataset: 'other', asset: null, interval: null, ext };
  }

  // data/chainlink[-twap-30s|-60s]/daily/prices/<ASSETUSD>/<file>
  if (segs[1]?.startsWith('chainlink')) {
    const dataset = segs[1] === 'chainlink-twap-30s' ? 'twap30s'
      : segs[1] === 'chainlink-twap-60s' ? 'twap60s'
        : 'prices';
    return { venue, dataset, asset: assetOf(segs[4]), interval: null, ext };
  }

  // data/polymarket/daily/<dataset>/<ASSET-interval>/<file>
  if (segs[1] === 'polymarket') {
    const dataset = DATASETS[segs[3]] ? segs[3] : 'other';
    const m = /^([A-Za-z]+)-(\d+[mMhHdD])$/.exec(segs[4] ?? '');
    return {
      venue,
      dataset,
      asset: assetOf(m?.[1] ?? segs[4]),
      interval: m ? m[2].toLowerCase() : null,
      ext,
    };
  }

  return { venue, dataset: 'other', asset: null, interval: null, ext };
}

/**
 * The token that names "this dimension does not apply to the file".
 *
 * `interval` is only meaningful for datasets that are sliced by market period
 * (book, price_change, klines, …); the settlement streams (prices, twap30s,
 * twap60s) are continuous and classify to interval:null. Without a way to name
 * that, `interval=5m` drops them — the SQL `WHERE interval='5m'` vs NULL trap,
 * where "not applicable" reads as "does not match". A customer wanting "5m
 * market data plus every period-less dataset" then cannot express it at all.
 *
 * Spelling it as a value rather than widening `interval=5m` implicitly keeps
 * the filter-never-widens rule: only a query that asks for it gets it, so
 * someone pulling just 5m klines is not handed the settlement streams too.
 * No real dimension value is 'none' (intervals are 1s…1mo, assets are BTC…ZEC),
 * so the token cannot collide with data.
 */
export const NO_VALUE = 'none';

/**
 * Does a classified file match a structured query? Absent filters match
 * everything; every supplied filter must match (AND), and each may be a
 * comma-separated list (OR within it). Within that list, NO_VALUE matches a
 * file whose dimension is null — `interval=5m,none`.
 */
export function matchesQuery(meta, q) {
  const hit = (want, got) => {
    if (!want) return true;
    const alts = String(want).toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
    if (alts.length === 0) return true;
    if (got == null) return alts.includes(NO_VALUE);
    return alts.includes(String(got).toLowerCase());
  };
  return hit(q.venue, meta.venue)
    && hit(q.dataset, meta.dataset)
    && hit(q.asset, meta.asset)
    && hit(q.interval, meta.interval);
}

/**
 * Distinct dimension values across a set of classified files (for /v1/meta).
 *
 * `nullable` names the dimensions some file leaves empty, so a caller can find
 * NO_VALUE without reading the docs — undiscoverable is how the interval=5m
 * complaint started. It is deliberately NOT folded into `assets`/`intervals`:
 * those have always held real symbols and real durations, and a client that
 * builds an enum from them, parses them as durations, or loops over every
 * interval to fetch data would break on a token — or quietly start pulling the
 * period-less files it never asked for.
 */
export function summarise(metas) {
  const s = { venues: new Set(), datasets: new Set(), assets: new Set(), intervals: new Set() };
  let assetless = false;
  let intervalless = false;
  for (const m of metas) {
    s.venues.add(m.venue);
    s.datasets.add(m.dataset);
    if (m.asset) s.assets.add(m.asset); else assetless = true;
    if (m.interval) s.intervals.add(m.interval); else intervalless = true;
  }
  const sortIntervals = (a, b) => {
    const unit = { m: 1, h: 60, d: 1440, w: 10080, mo: 43200 };
    const parse = (x) => {
      const mm = /^(\d+)(mo|[mhdw])$/.exec(x);
      return mm ? Number(mm[1]) * (unit[mm[2]] ?? 1) : Number.MAX_SAFE_INTEGER;
    };
    return parse(a) - parse(b);
  };
  return {
    venues: [...s.venues].sort(),
    datasets: [...s.datasets].sort(),
    assets: [...s.assets].sort(),
    intervals: [...s.intervals].sort(sortIntervals),
    nullable: [assetless ? 'asset' : null, intervalless ? 'interval' : null].filter(Boolean),
  };
}
