// Classify archive paths by venue, dataset, asset and interval. Unknown paths
// return dataset other and null dimensions so catalog files remain listable.

import { venueOfPath } from './venue-path.mjs';

/**
 * Collected asset prefixes matched at the start of a path segment.
 */
export const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE', 'ZEC'];

/**
 * Public dataset descriptions.
 */
export const DATASETS = {
  prices: 'Settlement feed, tick by tick (instantaneous Chainlink stream)',
  twap30s: 'TWAP 30s settlement stream — settled 5-minute markets before they moved to the 60s lookback; archived daily through 2026-10-19 (UTC)',
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
 * Chinese descriptions alongside DATASETS. Keep settlement wording in sync
 * with content/llms.txt, lib/i18n.ts and lib/docs-pages.ts.
 * data-taxonomy.test.mjs checks matching key sets.
 */
export const DATASETS_ZH = {
  prices: '结算价流，逐 tick（Chainlink 瞬时流）',
  twap30s: 'TWAP 30 秒结算流——5 分钟市场改用 60 秒回看之前的结算线，逐日归档至 2026-10-19（UTC）',
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
      // Map HOURLY and DAILY to 1h and 1d. Recognise periods explicitly:
      // BTC-OTHER and MARKET-<id> have no known interval.
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
 * NO_VALUE (none) explicitly matches null dimensions, e.g. interval=5m,none.
 * Continuous settlement streams have no interval. Explicit selection avoids
 * widening filters; none is not a real symbol or duration.
 */
/**
 * Archived assets excluded from public counts. ZEC markets were collected
 * but did not go live; their archived files remain available.
 */
export const UNLISTED_ASSETS = Object.freeze(['ZEC']);

/** The assets a public-facing figure should count. */
export const publicAssets = (assets) =>
  [...assets].filter((a) => !UNLISTED_ASSETS.includes(a)).sort();

export const NO_VALUE = 'none';

/**
 * Match filters with AND across dimensions and OR within comma-separated
 * values. Absent filters match all; NO_VALUE matches null dimensions.
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
 * Distinct values for /v1/meta. nullable lists dimensions containing nulls
 * without mixing sentinel values into symbol or duration lists.
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
