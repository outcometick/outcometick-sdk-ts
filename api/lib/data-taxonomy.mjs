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
export const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE', 'ZEC'];

/** Datasets, as a customer would name them. */
export const DATASETS = {
  prices: 'Settlement feed, tick by tick (instantaneous Chainlink stream)',
  twap30s: 'TWAP 30s settlement stream — settled 5-minute markets before they moved to the 60s lookback; still archived daily',
  twap60s: 'TWAP 60s settlement stream — settles both 5-minute and 15-minute markets',
  book: 'Full-depth order-book snapshots',
  best_bid_ask: 'Top of book, unthrottled — the same best bid/ask price_change carries, at every update rather than the capture cadence; prices only, no sizes, so depth still needs book or price_change',
  price_change: 'Order-book deltas with best bid/ask',
  last_trade_price: 'Trade prints, unthrottled',
  markets: 'Per-market metadata, strike and settlement outcome',
  tick_size_change: 'Tick-size changes',
  orderbook: 'Order-book snapshots (Predict.fun)',
  klines: 'OHLC candles derived from the settlement feed, with a tick count — no trade volume; the settlement feed is a price feed',
  other: 'Uncategorised',
};

/**
 * The same descriptions in Chinese.
 *
 * HERE, not in the page that renders them. Two of these lines state the
 * SETTLEMENT BASIS — which TWAP stream settles which market — and CLAUDE.md
 * pins that fact to four places that must move together. A Chinese copy living
 * in a component would be a fifth, and it would drift the way every other
 * hand-copy in this repo has: the basis already moved once (5-minute markets
 * settled on the 30s stream until 2026-08-07, on the 60s stream after), and an
 * AI assistant quoted a stale copy of our coverage back to a customer.
 *
 * Sitting beside DATASETS means changing one entry puts the other on screen in
 * the same diff. data-taxonomy.test.mjs asserts the key sets match, so a new
 * dataset cannot land with only one language.
 */
export const DATASETS_ZH = {
  prices: '结算价流，逐 tick（Chainlink 瞬时流）',
  twap30s: 'TWAP 30 秒结算流——5 分钟市场改用 60 秒回看之前的结算线，至今仍逐日归档',
  twap60s: 'TWAP 60 秒结算流——5 分钟与 15 分钟市场都判定在它上面',
  book: '全深度盘口快照',
  best_bid_ask: '盘口顶部，未抽稀——与 price_change 携带的是同一个最优买卖价，但每次更新都出一行，而不是按采集节奏；只有价格没有挂单量，深度仍需 book 或 price_change',
  price_change: '盘口增量，带最优买卖价',
  last_trade_price: '成交流，未抽稀',
  markets: '每个市场的元数据、strike 与结算结果',
  tick_size_change: '最小变动价位的变更',
  orderbook: '盘口快照（Predict.fun）',
  klines: '由结算价流推导的 OHLC K 线，带 tick 计数——没有成交量，结算流是价格流不是成交流',
  other: '未归类',
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
      // BTC-5M / BTC-15M / BTC-HOURLY / BTC-DAILY / BTC-OTHER / MARKET-<id>
      //
      // Predict names its hourly and daily series by word rather than by
      // duration. Both are mapped onto the vocabulary every other dataset
      // already uses, because the alternative cost customers real data twice
      // over:
      //
      //   HOURLY matched neither branch of the earlier pattern, so the whole
      //   series classified to interval:null. `interval=1h` returned an empty
      //   list — no error, just nothing — while the files sat in the archive,
      //   and /v1/meta never named the value at all, so a customer building an
      //   enumeration from it could not learn the data existed.
      //
      //   DAILY did match, but produced `daily`: a value no duration parser
      //   accepts, that sorts after 1mo because sortIntervals cannot read it,
      //   and that shares one array with the klines' own `1d` while meaning
      //   the same span.
      //
      // The list stays a whitelist. Widening the second group to \w+ would
      // turn BTC-OTHER into interval:'other' — inventing a period for the
      // series that exists precisely because its period is unknown.
      const BY_WORD = { HOURLY: '1h', DAILY: '1d' };
      const m = /^([A-Za-z]+)-(\d+[mMhHdD]|HOURLY|DAILY)$/.exec(segs[3] ?? '');
      const period = m?.[2];
      return {
        venue,
        dataset: 'orderbook',
        asset: assetOf(m?.[1] ?? segs[3]),
        interval: period ? (BY_WORD[period.toUpperCase()] ?? period.toLowerCase()) : null,
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
/**
 * In the archive, never offered publicly.
 *
 * ZEC markets were collected but never went live on the venue, so counting it
 * makes every public figure one too high — "Polymarket 8 assets" printed beside
 * a venue that shows seven. Excluded from what we ADVERTISE, not from what we
 * serve: a subscriber querying the archive still gets what the archive holds.
 */
export const UNLISTED_ASSETS = Object.freeze(['ZEC']);

/** The assets a public-facing figure should count. */
export const publicAssets = (assets) =>
  [...assets].filter((a) => !UNLISTED_ASSETS.includes(a)).sort();

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
