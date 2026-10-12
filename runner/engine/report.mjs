// Build reports from engine trade and fill logs, without access to strategy state.

import { contractValue, FEE_MODEL_PM } from './portfolio.mjs';

/** Entry-price buckets for the calibration panel. */
export const CALIBRATION_BUCKETS = Object.freeze([
  [0.0, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 0.4], [0.4, 0.5],
  [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.0],
]);

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);

function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
}

/** Round for reporting only; never for arithmetic that feeds another number. */
const r2 = (x) => (Number.isFinite(x) ? Number(x.toFixed(2)) : null);
const r4 = (x) => (Number.isFinite(x) ? Number(x.toFixed(4)) : null);
const r6 = (x) => (Number.isFinite(x) ? Number(x.toFixed(6)) : null);

/** Entry collateral (size × entry price), the return-on-collateral denominator. */
const collateralOf = (t) => (t.entry_px ?? 0) * (t.size ?? 0);

/**
 * Peak concurrent entry collateral, found by sweeping open/close events.
 * Overlapping positions add; sequential positions reuse capital. Skip trades
 * without timestamps rather than assuming concurrency.
 */
function peakCapital(trades) {
  const events = [];
  for (const t of trades) {
    if (t.opened_ms == null || t.closed_ms == null) continue;
    const amt = collateralOf(t);
    if (!(amt > 0)) continue;
    events.push([t.opened_ms, amt]);
    events.push([t.closed_ms, -amt]);
  }
  // Closes before opens at the same instant: a position that ends exactly when
  // the next begins did not need both stakes at once.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let peak = 0;
  for (const [, delta] of events) {
    cur += delta;
    if (cur > peak) peak = cur;
  }
  return peak;
}

/** Fraction of the run's span with a position open. */
function holdingRatio(trades) {
  const withTimes = trades.filter((t) => t.opened_ms != null && t.closed_ms != null);
  if (withTimes.length === 0) return null;
  // Avoid spread arguments: trade counts above ~100k can exceed the call limit.
  let first = Infinity;
  let last = -Infinity;
  for (const t of withTimes) {
    if (t.opened_ms < first) first = t.opened_ms;
    if (t.closed_ms > last) last = t.closed_ms;
  }
  const span = last - first;
  if (!(span > 0)) return null;
  // Union of the intervals, not their sum: two overlapping positions are one
  // stretch of being in the market, and summing them can exceed the span.
  const spans = withTimes
    .map((t) => [t.opened_ms, t.closed_ms])
    .sort((a, b) => a[0] - b[0]);
  let held = 0;
  let [s, e] = spans[0];
  for (const [a, b] of spans.slice(1)) {
    if (a > e) { held += e - s; [s, e] = [a, b]; } else if (b > e) e = b;
  }
  held += e - s;
  return held / span;
}

/**
 * Headline report metrics.
 */
export function metrics(trades, { feesPaid = 0, days = 1 } = {}) {
  const closed = trades.filter((t) => Number.isFinite(t.pnl));
  // Losing streaks require close-time order; shard flush order is not reliable.
  const pnls = [...closed]
    .sort((a, b) => (a.closed_ms ?? 0) - (b.closed_ms ?? 0))
    .map((t) => t.pnl);
  const netPnl = sum(pnls);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const collateral = sum(closed.map(collateralOf));
  const peak = peakCapital(closed);
  const hold = holdingRatio(closed);

  const equity = equityCurve(closed);
  const dd = maxDrawdown(equity.map((p) => p.equity));

  // Sharpe over per-day PnL, annualised at 365; these markets settle every
  // day of the week, so a 252-day year would overstate it.
  const byDay = new Map();
  for (const t of closed) {
    const day = t.closed_ms ? new Date(t.closed_ms).toISOString().slice(0, 10) : 'unknown';
    byDay.set(day, (byDay.get(day) ?? 0) + t.pnl);
  }
  const daily = [...byDay.values()];
  const sd = stdev(daily);
  const sharpe = sd === 0 ? null : (mean(daily) / sd) * Math.sqrt(365);
  // Sortino: the same daily P&L, scored against its downside only (target 0,
  // over every day). Keep in sync with metrics in client/backtest/report.py.
  let downSq = 0;
  let winningDays = 0;
  let bestDay = null;
  let worstDay = null;
  for (const d of daily) {
    if (d < 0) downSq += d * d;
    if (d > 0) winningDays += 1;
    if (bestDay == null || d > bestDay) bestDay = d;
    if (worstDay == null || d < worstDay) worstDay = d;
  }
  const downside = daily.length ? Math.sqrt(downSq / daily.length) : 0;
  const sortino = daily.length < 2 || downside === 0 ? null : (mean(daily) / downside) * Math.sqrt(365);

  const holds = closed
    .filter((t) => t.opened_ms != null && t.closed_ms != null)
    .map((t) => t.closed_ms - t.opened_ms);

  return {
    net_pnl: r2(netPnl),
    win_rate: closed.length ? r4(wins.length / closed.length) : null,
    // Profit factor is undefined when there are no losses.
    profit_factor: losses.length ? r2(sum(wins) / Math.abs(sum(losses))) : null,
    // Absolute drawdown needs no starting capital. Also report percentage
    // drawdown relative to the running peak.
    max_drawdown: dd.pct == null ? null : r4(dd.pct),
    max_drawdown_abs: r2(dd.abs),
    sharpe: sharpe == null ? null : r2(sharpe),
    sortino: sortino == null ? null : r2(sortino),
    // Net P&L over the worst peak-to-trough fall, both in dollars: comparable
    // across runs without a capital base we were never told.
    return_over_max_drawdown: dd.abs > 0 ? r2(netPnl / dd.abs) : null,
    trading_days: daily.length,
    winning_days: winningDays,
    best_day: bestDay == null ? null : r2(bestDay),
    worst_day: worstDay == null ? null : r2(worstDay),
    trades: closed.length,
    // Count distinct entered markets, including strategies with repeated entries.
    markets_traded: new Set(closed.map((t) => t.market_id)).size,
    // Return per dollar of entry collateral traded, including recycled stakes.
    return_on_collateral: collateral > 0 ? r4(netPnl / collateral) : null,
    // Return relative to peak concurrent collateral.
    peak_capital: r2(peak),
    return_on_peak: peak > 0 ? r4(netPnl / peak) : null,
    // Fraction of run time with an open position.
    holding_ratio: hold == null ? null : r4(hold),
    // Size-weighted realised edge per contract, in cents.
    edge_per_contract: closed.length ? r4(edgePerContract(closed)) : null,
    // Unweighted settled-trade edge can differ in sign from size-weighted edge.
    edge_per_trade: edgePerTrade(closed),
    brier_score: r4(brier(closed)),
    fees: r2(-Math.abs(feesPaid)),
    avg_hold_ms: holds.length ? Math.round(mean(holds)) : null,
    worst_losing_run: worstLosingRun(pnls),
    collateral_deployed: r2(collateral),
    market_days: days,
  };
}

/**
 * Mean realised edge per contract in dollars: outcome value minus entry price.
 * Values are 1/0 (0.5 for TIE). Exclude early exits: their realised prices
 * measure an exit against the market, not the settlement outcome.
 */
export function edgePerContract(trades) {
  const settled = trades.filter((t) => t.how === 'settled' && t.entry_px != null && t.outcome);
  if (!settled.length) return 0;
  let contracts = 0;
  let edge = 0;
  for (const t of settled) {
    edge += (contractValue(t.side, t.outcome) - t.entry_px) * t.size;
    contracts += t.size;
  }
  return contracts > 0 ? edge / contracts : 0;
}

/** Mean (outcome value - entry price) per settled trade, unweighted; null with none. */
export function edgePerTrade(trades) {
  const settled = trades.filter((t) => t.how === 'settled' && t.entry_px != null && t.outcome);
  if (!settled.length) return null;
  let edge = 0;
  for (const t of settled) edge += contractValue(t.side, t.outcome) - t.entry_px;
  return r4(edge / settled.length);
}

/**
 * Brier score over settled trades: mean squared error of the price as a
 * forecast. Lower is better; 0.25 is what you get by always saying 50%.
 */
export function brier(trades) {
  const settled = trades.filter((t) => t.how === 'settled' && t.entry_px != null && t.outcome);
  if (!settled.length) return null;
  return mean(settled.map((t) => {
    return (t.entry_px - contractValue(t.side, t.outcome)) ** 2;
  }));
}

/** Cap report equity points; equity.csv retains the full curve. */
export const EQUITY_MAX_POINTS = 2000;

/** How many trades the report shows as a preview; trades.csv has all. */
export const TRADES_HEAD = 20;

/**
 * Keep bucket minima and maxima in original order plus both endpoints.
 * A fixed stride could omit drawdown troughs. Output is bounded by max.
 */
export function downsampleEquity(points, max = EQUITY_MAX_POINTS) {
  if (points.length <= max) return points;
  const buckets = Math.floor((max - 2) / 2);
  const inner = points.length - 2;
  const keep = new Set([0, points.length - 1]);
  for (let b = 0; b < buckets; b++) {
    const lo = 1 + Math.floor((b * inner) / buckets);
    const hi = 1 + Math.floor(((b + 1) * inner) / buckets);
    let iMin = lo;
    let iMax = lo;
    for (let i = lo; i < hi; i++) {
      if (points[i].equity < points[iMin].equity) iMin = i;
      if (points[i].equity > points[iMax].equity) iMax = i;
    }
    if (hi > lo) { keep.add(iMin); keep.add(iMax); }
  }
  return [...keep].sort((a, b) => a - b).map((i) => points[i]);
}

/** Cumulative realised PnL, one point per closed trade. */
export function equityCurve(trades) {
  const ordered = [...trades].sort((a, b) => (a.closed_ms ?? 0) - (b.closed_ms ?? 0));
  let acc = 0;
  return ordered.map((t) => {
    acc += t.pnl;
    return { ts_ms: t.closed_ms, equity: acc };
  });
}

/**
 * Peak-to-trough decline relative to the running peak. Without a positive
 * peak, return absolute decline and a null percentage.
 */
export function maxDrawdown(series) {
  let peak = 0;
  let worstAbs = 0;
  let worstPct = null;
  for (const v of series) {
    if (v > peak) peak = v;
    const decline = peak - v;
    if (decline > worstAbs) {
      worstAbs = decline;
      worstPct = peak > 0 ? -(decline / peak) : null;
    }
  }
  return { abs: worstAbs, pct: worstPct };
}

/** Longest consecutive run of losing trades. */
export function worstLosingRun(pnls) {
  let worst = 0;
  let current = 0;
  for (const p of pnls) {
    if (p < 0) { current += 1; if (current > worst) worst = current; } else current = 0;
  }
  return worst;
}

/** Calibration of entry prices against realised settlement rates. */
export function calibration(trades) {
  const settled = trades.filter((t) => t.how === 'settled' && t.entry_px != null && t.outcome);
  return CALIBRATION_BUCKETS.map(([lo, hi]) => {
    const inBucket = settled.filter((t) => t.entry_px >= lo && t.entry_px < hi);
    if (!inBucket.length) return null;
    const implied = mean(inBucket.map((t) => t.entry_px));
    const realized = mean(inBucket.map((t) => contractValue(t.side, t.outcome)));
    return {
      bucket: `${lo.toFixed(2)}-${hi.toFixed(2)}`,
      lo,
      hi,
      implied: r4(implied),
      realized: r4(realized),
      // In cents, the unit the panel labels it in.
      edge_cents: r2((realized - implied) * 100),
      trades: inBucket.length,
    };
  }).filter(Boolean);
}

/** Baselines on the same markets, using the strategy's average trade size. */
export function baselines(marketSummaries, { size = 1 } = {}) {
  const out = { always_up: 0, always_down: 0, always_favourite: 0 };
  for (const m of marketSummaries) {
    if (!m.outcome || m.up_px == null || m.down_px == null) continue;
    out.always_up += (contractValue('UP', m.outcome) - m.up_px) * size;
    out.always_down += (contractValue('DOWN', m.outcome) - m.down_px) * size;
    // The favourite is the higher-priced outcome (higher implied probability).
    const favSide = m.up_px >= m.down_px ? 'UP' : 'DOWN';
    const favPx = Math.max(m.up_px, m.down_px);
    out.always_favourite += (contractValue(favSide, m.outcome) - favPx) * size;
  }
  return {
    always_up: r2(out.always_up),
    always_down: r2(out.always_down),
    always_favourite: r2(out.always_favourite),
  };
}

/**
 * Streaming taker slippage: avg_px against decision-time quoted_px, plus
 * unfilled size. Retain counters and one value per filled order for percentiles.
 * slippage(fills) uses the same accumulator for array input.
 */
export function slippageAccumulator() {
  let orders = 0;
  let atQuote = 0;
  let walked = 0;
  let nothing = 0;
  let cost = 0;
  let unfilledSize = 0;
  let requestedSize = 0;
  // Grow a Float64Array by doubling: 8 bytes per fill outside the V8 heap,
  // sorted in place without a second copy.
  let slips = new Float64Array(1024);
  let n = 0;
  return {
    add(f) {
      // Maker fills have no touch-price slippage; exclude them from this panel.
      if (f.action !== 'open' || f.liquidity === 'maker') return;
      orders += 1;
      if (f.filled > 0 && f.levels_walked === 1) atQuote += 1;
      if (f.filled > 0 && f.levels_walked > 1) walked += 1;
      if (f.filled === 0) nothing += 1;
      if (f.filled > 0 && f.quoted_px != null && f.avg_px != null) {
        if (n === slips.length) {
          const grown = new Float64Array(slips.length * 2);
          grown.set(slips);
          slips = grown;
        }
        slips[n++] = (f.avg_px - f.quoted_px) * 100;
        cost += (f.avg_px - f.quoted_px) * f.filled;
      }
      unfilledSize += f.unfilled;
      requestedSize += f.requested;
    },
    result() {
      if (!orders) {
        return {
          fills_at_quote: null, partial_fills: null, unfilled: null,
          median_slippage_cents: null, worst_1pct_slippage_cents: null, pnl_lost_to_slippage: null,
          orders: 0,
        };
      }
      const sorted = slips.subarray(0, n).sort();
      const at = (q) => (n ? sorted[Math.min(n - 1, Math.floor(q * n))] : null);
      return {
        orders,
        fills_at_quote: r4(atQuote / orders),
        partial_fills: r4(walked / orders),
        unfilled: r4(nothing / orders),
        median_slippage_cents: r2(at(0.5)),
        worst_1pct_slippage_cents: r2(at(0.99)),
        // Negative: this is money the strategy did not keep.
        pnl_lost_to_slippage: r2(-cost),
        // Size the book never had, as a fraction of what was asked for.
        unfilled_size_ratio: r4(unfilledSize / requestedSize),
      };
    },
  };
}

export function slippage(fills) {
  const acc = slippageAccumulator();
  for (const f of fills) acc.add(f);
  return acc.result();
}

/**
 * The fill-derived half of the maker block, fed one fill at a time: queue
 * position and time in queue per maker fill, markouts weighted by size.
 * Keep in sync with maker_fill_accumulator in client/backtest/report.py.
 */
export const MARKOUT_KEYS = Object.freeze([
  ['1s', 'markout_1s'], ['10s', 'markout_10s'], ['60s', 'markout_60s'], ['settle', 'markout_settle'],
]);

export function makerFillAccumulator() {
  const join = [];
  const atFill = [];
  const inQueue = [];
  let fills = 0;
  let size = 0;
  const mk = Object.fromEntries(MARKOUT_KEYS.map(([k]) => [k, { sum: 0, size: 0, n: 0 }]));
  return {
    add(f) {
      if (f.liquidity !== 'maker' || !(f.filled > 0)) return;
      fills += 1;
      size += f.filled;
      if (Number.isFinite(f.queue_ahead_at_join)) join.push(f.queue_ahead_at_join);
      if (Number.isFinite(f.queue_ahead_at_fill)) atFill.push(f.queue_ahead_at_fill);
      if (Number.isFinite(f.time_in_queue_ms)) inQueue.push(f.time_in_queue_ms);
      for (const [k, field] of MARKOUT_KEYS) {
        const v = f[field];
        if (!Number.isFinite(v)) continue;
        mk[k].sum += v * f.filled;
        mk[k].size += f.filled;
        mk[k].n += 1;
      }
    },
    result() {
      const median = (xs) => {
        if (!xs.length) return null;
        const s = [...xs].sort((a, b) => a - b);
        return s[Math.min(s.length - 1, Math.floor(0.5 * s.length))];
      };
      return {
        fills,
        size,
        median_ahead_at_join: median(join),
        median_ahead_at_fill: median(atFill),
        median_time_in_queue_ms: median(inQueue),
        markout: Object.fromEntries(MARKOUT_KEYS.map(([k]) => [k, {
          // Per share, size-weighted, over the fills that had a value.
          mean: mk[k].size > 0 ? mk[k].sum / mk[k].size : null,
          fills: mk[k].n,
          size: mk[k].size,
        }])),
      };
    },
  };
}

/** What the report needs from the fill log: its size, the slippage panel, the maker fills. */
export function fillStats(fills) {
  const maker = makerFillAccumulator();
  for (const f of fills) maker.add(f);
  const activity = activityAccumulator();
  for (const f of fills) activity.add(f);
  return { count: fills.length, slippage: slippage(fills), makerFills: maker.result(), activity: activity.result() };
}

/**
/**
 * Maker report from summed engine stats and makerFillAccumulator().result().
 * Null if no resting orders were submitted. Include model and lag assumptions.
 * Keep in sync with maker_report in client/backtest/report.py.
 */
export function makerReport({ stats, fills, queueModel, queueProb = null, printLagMs }) {
  if (!stats || !(stats.submitted > 0)) return null;
  const rate = (a, b) => (b > 0 ? r4(a / b) : null);
  const f = fills ?? makerFillAccumulator().result();
  return {
    queue_model: queueModel,
    // Include the probability function when a queue model was selected.
    ...(queueProb ? { queue_prob: { prob: queueProb.prob, n: queueProb.n ?? null } } : {}),
    print_lag_ms: printLagMs,
    orders: {
      submitted: stats.submitted,
      rested: stats.rested,
      with_maker_fill: stats.orders_with_maker_fill,
      fully_filled: stats.fully_filled,
      cancelled: stats.cancelled,
      cancelled_before_entry: stats.cancelled_before_entry,
      cancelled_no_position: stats.cancelled_no_position,
      expired: stats.expired,
      rejected_invalid: stats.rejected_invalid,
      rejected_post_only: stats.rejected_post_only,
      rejected_self_cross: stats.rejected_self_cross,
      rejected_duplicate_id: stats.rejected_duplicate_id,
    },
    size: {
      rested: r2(stats.rested_size),
      maker_filled: r2(stats.maker_filled_size),
      taker_on_arrival: r2(stats.taker_on_arrival_size),
    },
    // Of what rested, how much the queue model filled; by size and by order.
    fill_rate_size: rate(stats.maker_filled_size, stats.rested_size),
    fill_rate_orders: rate(stats.orders_with_maker_fill, stats.rested),
    maker_fills: f.fills,
    median_ahead_at_join: r2(f.median_ahead_at_join),
    median_ahead_at_fill: r2(f.median_ahead_at_fill),
    median_time_in_queue_ms: f.median_time_in_queue_ms,
    markout: Object.fromEntries(Object.entries(f.markout).map(([k, m]) => [k, {
      mean: r4(m.mean), fills: m.fills, size: r2(m.size),
    }])),
    // Entry-window suppressed volume and crossing-book episodes without prints.
    lag_suppressed_size: r2(stats.lag_suppressed_size),
    crossed_observations: stats.crossed_observations,
  };
}

/**
 * The report's `orders` block: which execution options the run used, what they
 * refused, and the rebate estimate. Null when the run enabled none.
 * Keep in sync with orders_report in client/backtest/report.py.
 */
export function ordersReport({ policy, stats }) {
  if (!policy || (!policy.fok && !policy.order_rules && policy.maker_rebate == null
    && !policy.quote_guard && !policy.mirror_depth)) return null;
  const rules = policy.order_rules;
  return {
    fok: Boolean(policy.fok),
    order_rules: rules == null ? null : (rules.mode === 'assumed'
      ? {
        mode: 'assumed', assumed_tick: rules.tick, assumed_min_size: rules.min_size, size_step: rules.size_step,
        note: 'archive markets do not carry their tick or minimum size: these are values measured on the archive, '
          + 'not read per market — a market quoting in 0.01 would refuse a 0.001 limit accepted here, one quoting finer '
          + 'would accept limits refused here',
      }
      : { mode: 'venue', size_step: 0.01, note: 'tick and minimum size read from each market' }),
    quote_guard: policy.quote_guard == null ? null : {
      ...policy.quote_guard,
      applies_to: policy.quote_guard.include_exits ? 'opening and exit taker orders' : 'opening taker orders (exits are never blocked)',
    },
    mirror_depth: policy.mirror_depth ?? null,
    maker_rebate: policy.maker_rebate == null ? null : {
      rate: policy.maker_rebate,
      total: r2(stats?.rebates ?? 0),
      note: 'an estimate: the venue pays maker rebates from a daily pool, pro rata, not per fill',
    },
    rejected: { ...(stats?.rejected ?? {}) },
  };
}

/** PnL split by asset and market period, for the by-market panel. */
export function splitByMarket(trades, marketMeta = new Map()) {
  const groups = new Map();
  for (const t of trades) {
    const meta = marketMeta.get(t.market_id) ?? {};
    const key = `${meta.asset ?? 'unknown'} ${meta.interval ?? ''}`.trim();
    const g = groups.get(key) ?? { name: key, pnl: 0, trades: 0 };
    g.pnl += t.pnl;
    g.trades += 1;
    groups.set(key, g);
  }
  const rows = [...groups.values()].map((g) => ({ ...g, pnl: r2(g.pnl) }));
  rows.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
  return rows;
}


/** markets.csv columns: one row per market replayed, entered or not. */
export const MARKET_COLUMNS = Object.freeze([
  'market_id', 'asset', 'interval', 'settlement', 'open_ts_ms', 'close_ts_ms', 'strike', 'outcome',
  'up_px', 'down_px', 'entered', 'trades', 'contracts', 'net_pnl', 'fees', 'first_entry_ms',
  'edge_per_contract', 'edge_per_trade',
]);

/**
 * One row per replayed market, entered or not, in market-list order. Includes
 * unentered markets for market-level confidence intervals and permutation tests.
 * Keep in sync with market_rows in client/backtest/report.py.
 */
export function marketRows(trades, marketMeta = new Map()) {
  const byMarket = new Map();
  for (const t of trades) {
    if (!Number.isFinite(t.pnl)) continue;
    let g = byMarket.get(t.market_id);
    if (!g) { g = []; byMarket.set(t.market_id, g); }
    g.push(t);
  }
  const rows = [];
  for (const [id, m] of marketMeta) {
    const ts = byMarket.get(id) ?? [];
    let pnl = 0;
    let fees = 0;
    let contracts = 0;
    let first = null;
    for (const t of ts) {
      pnl += t.pnl;
      fees += t.fees ?? 0;
      contracts += t.size ?? 0;
      if (t.opened_ms != null && (first == null || t.opened_ms < first)) first = t.opened_ms;
    }
    const settled = ts.filter((t) => t.how === 'settled' && t.entry_px != null && t.outcome);
    rows.push({
      market_id: id,
      asset: m.asset ?? null,
      interval: m.interval ?? null,
      settlement: m.stream ?? null,
      open_ts_ms: m.open_ts_ms ?? null,
      close_ts_ms: m.close_ts_ms ?? null,
      strike: m.strike ?? null,
      outcome: m.outcome ?? null,
      up_px: m.up_px ?? null,
      down_px: m.down_px ?? null,
      entered: ts.length > 0,
      trades: ts.length,
      contracts: r4(contracts),
      net_pnl: r4(pnl),
      fees: r4(fees),
      first_entry_ms: first,
      edge_per_contract: settled.length ? r4(edgePerContract(settled)) : null,
      edge_per_trade: edgePerTrade(settled),
    });
  }
  return rows;
}

/** Report settlement streams separately, built from marketRows and sorted by rule. */
export function bySettlement(rows, trades) {
  const rule = new Map(rows.map((r) => [r.market_id, r.settlement ?? 'unknown']));
  const groups = new Map();
  const group = (k) => {
    let g = groups.get(k);
    if (!g) { g = { settlement: k, markets: 0, markets_entered: 0, trades: [] }; groups.set(k, g); }
    return g;
  };
  for (const r of rows) {
    const g = group(r.settlement ?? 'unknown');
    g.markets += 1;
    if (r.entered) g.markets_entered += 1;
  }
  for (const t of trades) {
    if (!Number.isFinite(t.pnl) || !rule.has(t.market_id)) continue;
    group(rule.get(t.market_id)).trades.push(t);
  }
  return [...groups.values()]
    .sort((a, b) => (a.settlement < b.settlement ? -1 : a.settlement > b.settlement ? 1 : 0))
    .map((g) => {
      let pnl = 0;
      for (const t of g.trades) pnl += t.pnl;
      const settled = g.trades.filter((t) => t.how === 'settled' && t.entry_px != null && t.outcome);
      return {
        settlement: g.settlement,
        markets: g.markets,
        markets_entered: g.markets_entered,
        trades: g.trades.length,
        net_pnl: r2(pnl),
        edge_per_contract: settled.length ? r4(edgePerContract(settled)) : null,
        edge_per_trade: edgePerTrade(settled),
      };
    });
}

/**
 * Trading activity off the fill log, one fill at a time: contracts and dollars
 * that changed hands, taker and maker. Keep in sync with ActivityAccumulator in
 * client/backtest/report.py.
 */
export function activityAccumulator() {
  let contracts = 0;
  let value = 0;
  let taker = 0;
  let maker = 0;
  let fills = 0;
  return {
    add(f) {
      if (!(f.filled > 0) || !Number.isFinite(f.avg_px)) return;
      fills += 1;
      contracts += f.filled;
      value += f.filled * f.avg_px;
      if (f.liquidity === 'maker') maker += f.filled;
      else taker += f.filled;
    },
    result() {
      return { fills, contracts: r2(contracts), value: r2(value), taker_contracts: r2(taker), maker_contracts: r2(maker) };
    },
  };
}

/** What the recorder's values mean, stated in every report that has them. */
export const RECORD_VALUATION = 'liquidation at the best bid; a leg with no bid counts 0; quotes are not checked for freshness';

/**
 * Account series on an absolute record_ms grid. Each instance contributes zero
 * before its first sample, then its latest sample at or before the point,
 * retaining its final sample after it ends. Sweep in (ts, write order).
 * maxRows bounds samples plus account points before allocation. Exceeding it
 * returns {truncated:true, points:[]}.
 * Keep in sync with account_series in client/backtest/report.py.
 */
export function accountSeries(samples, recordMs, { maxRows = Infinity } = {}) {
  const n = samples.length;
  if (!n || !(recordMs > 0)) return { truncated: false, points: [] };
  let first = Infinity;
  let last = -Infinity;
  for (const s of samples) {
    if (s.ts < first) first = s.ts;
    if (s.final && s.ts > last) last = s.ts;
  }
  if (last === -Infinity) for (const s of samples) if (s.ts > last) last = s.ts;
  const g0 = Math.ceil(first / recordMs) * recordMs;
  const gridCount = Math.max(0, Math.floor(last / recordMs) - Math.ceil(first / recordMs) + 1);
  const total = gridCount + (last % recordMs === 0 ? 0 : 1);
  if (n + total > maxRows) return { truncated: true, points: [] };
  const order = samples.map((_, i) => i).sort((a, b) => (samples[a].ts - samples[b].ts) || (a - b));
  const latest = new Map();
  let value = 0;
  let position = 0;
  let open = 0;
  let i = 0;
  const points = [];
  const advanceTo = (t) => {
    while (i < n && samples[order[i]].ts <= t) {
      const s = samples[order[i]];
      const v = (s.cash + s.marked) + s.position_value;
      const prev = latest.get(s.key);
      if (prev) {
        value += v - prev.v;
        position += s.position_value - prev.p;
        if (prev.p > 0) open -= 1;
      } else {
        value += v;
        position += s.position_value;
      }
      if (s.position_value > 0) open += 1;
      latest.set(s.key, { v, p: s.position_value });
      i += 1;
    }
    points.push({ ts: t, value, position_value: position, open_positions: open });
  };
  for (let k = 0; k < gridCount; k += 1) advanceTo(g0 + k * recordMs);
  if (last % recordMs !== 0) advanceTo(last);
  return { truncated: false, points };
}

/**
 * The report's `record` block (and the rows for record.csv /
 * record_markets.csv). `harness` is the result's `record`
 * ({rows, bytes, truncated}); a truncated run reports that and nothing else.
 */
export function recordReport({ samples, recordMs, harness, maxRows }) {
  if (!recordMs) return { block: null, points: [], samples: [] };
  if (!harness || harness.truncated) {
    return { block: { interval_ms: recordMs, truncated: true }, points: [], samples: [] };
  }
  const series = accountSeries(samples, recordMs, { maxRows });
  if (series.truncated) {
    return { block: { interval_ms: recordMs, truncated: true }, points: [], samples: [] };
  }
  const pts = series.points;
  let peak = 0;
  let maxDd = 0;
  let ddAt = null;
  let worst = null;
  let maxPos = 0;
  let sumPos = 0;
  for (const p of pts) {
    if (p.value > peak) peak = p.value;
    if (peak - p.value > maxDd) { maxDd = peak - p.value; ddAt = p.ts; }
    if (worst == null || p.value < worst.value) worst = { ts: p.ts, value: p.value };
    if (p.position_value > maxPos) maxPos = p.position_value;
    sumPos += p.position_value;
  }
  return {
    block: {
      interval_ms: recordMs,
      truncated: false,
      valuation: RECORD_VALUATION,
      points: pts.length,
      instances: new Set(samples.map((s) => s.key)).size,
      final_value: pts.length ? r2(pts[pts.length - 1].value) : null,
      max_drawdown_abs: r2(maxDd),
      max_drawdown_at: ddAt,
      worst_point: worst ? { ts: worst.ts, value: r2(worst.value) } : null,
      max_position_value: r2(maxPos),
      mean_position_value: pts.length ? r2(sumPos / pts.length) : null,
    },
    // Round exported rows to 6 decimals to preserve 5-decimal money and
    // remove float noise. Compute the block above from unrounded values.
    points: pts.map((p) => ({ ...p, value: r6(p.value), position_value: r6(p.position_value) })),
    samples: samples.map((x) => ({ ...x, cash: r6(x.cash), marked: r6(x.marked), position_value: r6(x.position_value) })),
  };
}

/** Arrange sweep-cell metrics on the x/y parameter grid. */
export function sweepPanel(cells, { xParam, yParam, metric = 'sharpe' }) {
  const xs = [...new Set(cells.map((c) => c.params[xParam]))].sort((a, b) => a - b);
  const ys = [...new Set(cells.map((c) => c.params[yParam]))].sort((a, b) => a - b);
  const grid = ys.map((y) => xs.map((x) => {
    const cell = cells.find((c) => c.params[xParam] === x && c.params[yParam] === y);
    return cell ? r2(cell.metrics[metric]) : null;
  }));
  const flat = grid.flat().filter((v) => v != null);
  return {
    metric,
    x_param: xParam,
    y_param: yParam,
    x_labels: xs,
    y_labels: ys,
    grid,
    max: flat.length ? Math.max(...flat) : null,
    min: flat.length ? Math.min(...flat) : null,
    cells: cells.length,
  };
}

/**
 * Fee policy, model, rounding assumptions and market schedule counts. Unknown
 * venue schedules are charged zero and reported separately. markets contains
 * replayed records with normalised fee data (feeOf in events.mjs).
 * Keep in sync with fee_model_report in client/backtest/report.py.
 */
export function feeModelReport({ policy, markets }) {
  const venue = policy?.mode !== 'bps';
  const counts = { charged: 0, known_zero: 0, unknown: 0 };
  for (const m of markets ?? []) {
    const fee = m?.fee ?? null;
    if (fee?.model === FEE_MODEL_PM) counts.charged += 1;
    else if (fee?.model === 'none') counts.known_zero += 1;
    else counts.unknown += 1;
  }
  return {
    mode: venue ? 'venue' : 'bps',
    bps: venue ? null : (Number.isFinite(policy?.bps) ? policy.bps : 0),
    model: venue ? FEE_MODEL_PM : null,
    // The venue rounds per match; the archive has book levels, not the maker
    // orders inside them. See feeFor in portfolio.mjs.
    rounding: venue ? 'per book level taken, 5 decimals, ties up' : null,
    estimate: venue,
    markets: venue ? counts : null,
  };
}

/** Assemble the report, preserving archive stream coverage and gaps unchanged. */
/**
 * The book_age block from the harness counters (newBookAge in portfolio.mjs),
 * or null when no taker fill took archive depth.
 * Keep in sync with book_age_report in client/backtest/report.py.
 */
export function bookAgeReport(raw) {
  if (!raw || !(raw.size_micro > 0)) return null;
  const size = (micro) => r6(micro / 1e6);
  const [a, b, c, d] = raw.by_age_micro;
  return {
    taker_fills: raw.fills,
    taker_size: size(raw.size_micro),
    size_by_level_age: { under_1s: size(a), '1s_to_5s': size(b), '5s_to_30s': size(c), over_30s: size(d) },
    share_over_1s: r6((raw.size_micro - a) / raw.size_micro),
    max_level_age_ms: raw.max_age_ms,
    note: 'Taker size by the age of the book level it consumed: fill time minus when that level was last set by a snapshot or delta (archive markets only). The archive drops some deltas, so an older level is more likely to have left the venue already; bbo removes stale levels better than the best price, not deeper ones.',
  };
}

export function buildReport({
  runId, submittedAt, manifest, scope, sourceSha256 = null,
  trades, fillStats: fillSummary, marketSummaries, marketMeta,
  feesPaid = 0, fillDelayMs = 0, feeModel = null, sweep = null, coverage = null,
  crosschecks = [], budget = null, seed = null, scanned = {}, maker = null, orders = null, timers = null,
  fingerprint = null, record = null, spot = null, bookAge = null,
}) {
  const closed = trades.filter((t) => Number.isFinite(t.pnl));
  const bookAgeBlock = bookAgeReport(bookAge);
  const equity = equityCurve(closed);
  const matched = crosschecks.filter((c) => c.match).length;

  return {
    run_id: runId,
    // Strategy source digest for identifying the version used.
    source_sha256: sourceSha256,
    // Pre-registration: code + manifest + params + options + scope + seed, one
    // sha256 (api/lib/backtest-fingerprint.mjs). Null where it cannot be formed.
    fingerprint,
    generated_ms: submittedAt,
    sdk_schema: manifest?.schema ?? null,
    language: manifest?.language ?? null,
    mode: manifest?.mode ?? 'market',
    seed,
    scope: {
      venue: scope?.venue ?? null,
      assets: scope?.assets ?? [],
      from: scope?.from ?? null,
      to: scope?.to ?? null,
      market_days: scope?.marketDays ?? null,
    },
    scanned,
    metrics: metrics(closed, { feesPaid, days: scope?.archivedDayCount ?? 1 }),
    // Thinned. The full curve is equity.csv in the archive.
    equity: downsampleEquity(equity).map((p) => ({ ts_ms: p.ts_ms, equity: r2(p.equity) })),
    crosscheck: {
      markets_touched: new Set(closed.map((t) => t.market_id)).size,
      recompute_checks: crosschecks.length,
      recompute_matches: matched,
      // Include mismatch count even when no checks ran.
      mismatches: crosschecks.length - matched,
    },
    // Bound JSON row previews; full rows live in trades.csv / fills.csv.
    // trades_head distinguishes the preview from the full trades array.
    trades_head: closed.slice(0, TRADES_HEAD),
    rows: { trades: closed.length, fills: fillSummary.count, equity_points: equity.length },
    calibration: calibration(closed),
    // Compare using the strategy's average trade size.
    baselines: baselines(marketSummaries ?? [], {
      size: closed.length ? closed.reduce((a, t) => a + (t.size ?? 0), 0) / closed.length : 1,
    }),
    split: splitByMarket(closed, marketMeta ?? new Map()),
    // By settlement rule, every market counted (entered or not); see bySettlement.
    by_settlement: bySettlement(marketRows(closed, marketMeta ?? new Map()), closed),
    // Contracts and dollars traded, from the fill log.
    activity: fillSummary.activity ?? null,
    // From the caller's pass over the fill log (fillStats / the worker's
    // streaming pass): the log itself is never handed to the report.
    slippage: fillSummary.slippage,
    // Execution delay used for this run's replay.
    fill_delay_ms: fillDelayMs,
    fee_model: feeModel,
    // Resting orders, when the strategy used any (makerReport).
    maker,
    // Execution options and rejections, when enabled.
    ...(orders ? { orders } : {}),
    // Timers (on_timer): how many were set, fired, and dropped at the end of
    // trading; only when the strategy declared the hook.
    ...(timers ? { timers } : {}),
    // The time-grid mark-to-market (record_ms); only when the run asked for it.
    ...(record ? { record } : {}),
    // The spot dataset: how many markets had any spot value -- only when declared.
    ...(spot ? { spot } : {}),
    // Taker size by the age of the level it took (archive markets).
    ...(bookAgeBlock ? { book_age: bookAgeBlock } : {}),
    sweep,
    coverage,
    budget,
  };
}
