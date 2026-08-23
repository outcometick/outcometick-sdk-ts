// Turning a run's trades and fills into the report.
//
// Every panel here exists to make the data's value visible, not the strategy's.
// Calibration, latency and slippage are the three that most often kill a
// promising curve, and they are on by default for exactly that reason — a
// backtest that only showed an equity line would be flattering by omission.
//
// Nothing in this module can see the strategy. It reads the trade and fill logs
// the engine produced, so a report cannot be tuned by the thing it is judging.

/** Delays the latency panel re-prices every fill at. */
export const LATENCY_STEPS = Object.freeze([
  { label: 'as captured (0 ms)', ms: 0 },
  { label: '+100 ms', ms: 100 },
  { label: '+250 ms', ms: 250 },
  { label: '+500 ms', ms: 500 },
  { label: '+1 s', ms: 1000 },
  { label: '+2 s', ms: 2000 },
]);

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

/** Round for reporting only — never for arithmetic that feeds another number. */
const r2 = (x) => (Number.isFinite(x) ? Number(x.toFixed(2)) : null);
const r4 = (x) => (Number.isFinite(x) ? Number(x.toFixed(4)) : null);

/**
 * Collateral a trade tied up: contracts times the price paid.
 *
 * The denominator for return-on-collateral. Using notional-at-settlement
 * instead would flatter cheap entries, which is the opposite of what this
 * report is for.
 */
const collateralOf = (t) => (t.entry_px ?? 0) * (t.size ?? 0);

/**
 * Headline metrics — the twelve cells at the top of the report.
 */
export function metrics(trades, { feesPaid = 0, days = 1 } = {}) {
  const closed = trades.filter((t) => Number.isFinite(t.pnl));
  // In CLOSE order. "Longest losing streak" is a statement about a sequence in
  // time, and `trades` arrives in whatever order the worker flushed markets —
  // roughly chronological, but not guaranteed, and a run that sharded would
  // report a streak that never happened.
  const pnls = [...closed]
    .sort((a, b) => (a.closed_ms ?? 0) - (b.closed_ms ?? 0))
    .map((t) => t.pnl);
  const netPnl = sum(pnls);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const collateral = sum(closed.map(collateralOf));

  const equity = equityCurve(closed);
  const dd = maxDrawdown(equity.map((p) => p.equity));

  // Sharpe over per-day PnL, annualised at 365 — these markets settle every
  // day of the week, so a 252-day year would overstate it.
  const byDay = new Map();
  for (const t of closed) {
    const day = t.closed_ms ? new Date(t.closed_ms).toISOString().slice(0, 10) : 'unknown';
    byDay.set(day, (byDay.get(day) ?? 0) + t.pnl);
  }
  const daily = [...byDay.values()];
  const sd = stdev(daily);
  const sharpe = sd === 0 ? null : (mean(daily) / sd) * Math.sqrt(365);

  const holds = closed
    .filter((t) => t.opened_ms != null && t.closed_ms != null)
    .map((t) => t.closed_ms - t.opened_ms);

  return {
    net_pnl: r2(netPnl),
    win_rate: closed.length ? r4(wins.length / closed.length) : null,
    // Gross profit over gross loss. Undefined rather than Infinity when there
    // were no losses — a number that cannot be compared is worse than a blank.
    profit_factor: losses.length ? r2(sum(wins) / Math.abs(sum(losses))) : null,
    // Absolute dollars is the headline figure, because a PERCENTAGE needs a
    // capital base we were never told. Measuring against the running peak — the
    // textbook definition — reports -171% for a curve that went +50 then -35,
    // which is arithmetically true and useless. The percentage is still
    // published, defined against the running peak, for anyone who wants it.
    max_drawdown: dd.pct == null ? null : r4(dd.pct),
    max_drawdown_abs: r2(dd.abs),
    sharpe: sharpe == null ? null : r2(sharpe),
    trades: closed.length,
    return_on_collateral: collateral > 0 ? r4(netPnl / collateral) : null,
    // Cents of edge per contract: what the outcome was worth minus what was
    // paid, averaged. This is the number that says whether there was an edge
    // at all, as opposed to a lucky run of variance.
    edge_per_contract: closed.length ? r4(edgePerContract(closed)) : null,
    brier_score: r4(brier(closed)),
    fees: r2(-Math.abs(feesPaid)),
    avg_hold_ms: holds.length ? Math.round(mean(holds)) : null,
    worst_losing_run: worstLosingRun(pnls),
    collateral_deployed: r2(collateral),
    market_days: days,
  };
}

/**
 * Mean realised edge per contract, in dollars.
 *
 * A binary token bought at p is worth 1 if its side settles and 0 otherwise, so
 * the edge on one contract is (outcome - p). Only settled trades carry an
 * outcome; a trade closed early is edge against the market, not against the
 * truth, and is excluded rather than scored as if it had settled.
 */
export function edgePerContract(trades) {
  const settled = trades.filter((t) => t.how === 'settled' && t.entry_px != null && t.outcome);
  if (!settled.length) return 0;
  let contracts = 0;
  let edge = 0;
  for (const t of settled) {
    const won = t.outcome === t.side ? 1 : 0;
    edge += (won - t.entry_px) * t.size;
    contracts += t.size;
  }
  return contracts > 0 ? edge / contracts : 0;
}

/**
 * Brier score over settled trades: mean squared error of the price as a
 * forecast. Lower is better; 0.25 is what you get by always saying 50%.
 */
export function brier(trades) {
  const settled = trades.filter((t) => t.how === 'settled' && t.entry_px != null && t.outcome);
  if (!settled.length) return null;
  return mean(settled.map((t) => {
    const won = t.outcome === t.side ? 1 : 0;
    return (t.entry_px - won) ** 2;
  }));
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
 * Peak-to-trough decline.
 *
 * Expressed against the running peak, so a drawdown early in a run is not
 * diluted by profits that had not happened yet. A curve that never reaches a
 * positive peak reports the absolute decline and a null percentage rather than
 * dividing by something near zero and printing -4000%.
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

/**
 * Calibration: what you paid, against what actually settled.
 *
 * The panel this feeds is the one that separates edge from variance. Buckets
 * where the realised rate sits above the price paid are where the money came
 * from; everywhere else is a good equity curve wearing variance.
 */
export function calibration(trades) {
  const settled = trades.filter((t) => t.how === 'settled' && t.entry_px != null && t.outcome);
  return CALIBRATION_BUCKETS.map(([lo, hi]) => {
    const inBucket = settled.filter((t) => t.entry_px >= lo && t.entry_px < hi);
    if (!inBucket.length) return null;
    const implied = mean(inBucket.map((t) => t.entry_px));
    const realized = mean(inBucket.map((t) => (t.outcome === t.side ? 1 : 0)));
    return {
      bucket: `${lo.toFixed(2)} – ${hi.toFixed(2)}`,
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

/**
 * Naive baselines over the same markets, at the SAME SIZE the strategy traded.
 *
 * The size matters or the panel is meaningless: a baseline priced at one
 * contract sitting next to a strategy that traded five hundred compares two
 * different quantities and makes the strategy look several hundred times
 * better than it is. The caller passes the strategy's average trade size.
 *
 * Not decoration: if a strategy cannot beat buying the favourite, no parameter
 * sweep is going to save it, and the customer should find that out here rather
 * than after a month of subscription.
 */
export function baselines(marketSummaries, { size = 1 } = {}) {
  const out = { always_up: 0, always_down: 0, always_favourite: 0 };
  for (const m of marketSummaries) {
    if (!m.outcome || m.up_px == null || m.down_px == null) continue;
    out.always_up += ((m.outcome === 'UP' ? 1 : 0) - m.up_px) * size;
    out.always_down += ((m.outcome === 'DOWN' ? 1 : 0) - m.down_px) * size;
    // The favourite is the side the market thinks is MORE likely, and on a
    // binary market the price IS the implied probability — so it is the DEARER
    // side, not the cheaper one. This was inverted: the panel labelled "always
    // buy the favourite" was actually buying the underdog every time, which
    // handed customers a backwards comparison to judge their strategy against.
    const favSide = m.up_px >= m.down_px ? 'UP' : 'DOWN';
    const favPx = Math.max(m.up_px, m.down_px);
    out.always_favourite += ((m.outcome === favSide ? 1 : 0) - favPx) * size;
  }
  return {
    always_up: r2(out.always_up),
    always_down: r2(out.always_down),
    always_favourite: r2(out.always_favourite),
  };
}

/**
 * Fill quality against the depth that was resting.
 *
 * `quoted_px` is the price on the screen when the order was sent and `avg_px`
 * is what it actually cost. The gap is the slippage, and the unfilled remainder
 * is the size the book never had.
 */
export function slippage(fills) {
  const attempted = fills.filter((f) => f.action === 'open');
  if (!attempted.length) {
    return {
      fills_at_quote: null, partial_fills: null, unfilled: null,
      median_slippage_cents: null, worst_1pct_slippage_cents: null, pnl_lost_to_slippage: null,
      orders: 0,
    };
  }
  const atQuote = attempted.filter((f) => f.filled > 0 && f.levels_walked === 1);
  const walked = attempted.filter((f) => f.filled > 0 && f.levels_walked > 1);
  const nothing = attempted.filter((f) => f.filled === 0);

  const slips = attempted
    .filter((f) => f.filled > 0 && f.quoted_px != null && f.avg_px != null)
    .map((f) => (f.avg_px - f.quoted_px) * 100);
  const sorted = [...slips].sort((a, b) => a - b);
  const at = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);

  const cost = sum(attempted
    .filter((f) => f.filled > 0 && f.quoted_px != null && f.avg_px != null)
    .map((f) => (f.avg_px - f.quoted_px) * f.filled));

  return {
    orders: attempted.length,
    fills_at_quote: r4(atQuote.length / attempted.length),
    partial_fills: r4(walked.length / attempted.length),
    unfilled: r4(nothing.length / attempted.length),
    median_slippage_cents: r2(at(0.5)),
    worst_1pct_slippage_cents: r2(at(0.99)),
    // Negative: this is money the strategy did not keep.
    pnl_lost_to_slippage: r2(-cost),
    // Size the book never had, as a fraction of what was asked for.
    unfilled_size_ratio: r4(sum(attempted.map((f) => f.unfilled)) / sum(attempted.map((f) => f.requested))),
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

/**
 * The latency panel: net PnL if every fill had landed later.
 *
 * The rows come from re-running the replay at each delay, which the caller
 * does — this only shapes the result. We keep event time, upstream server time
 * and our receive time separate on every row, which is what makes re-pricing at
 * an arbitrary delay meaningful rather than a guess.
 */
export function latencyPanel(resultsByDelay) {
  const base = resultsByDelay.find((r) => r.delayMs === 0)?.netPnl ?? 0;
  return resultsByDelay.map((r) => ({
    label: LATENCY_STEPS.find((s) => s.ms === r.delayMs)?.label ?? `+${r.delayMs} ms`,
    delay_ms: r.delayMs,
    net_pnl: r2(r.netPnl),
    // Relative to the as-captured run, so the shape of the decay is readable
    // without dividing in your head.
    ratio: base === 0 ? null : r4(r.netPnl / base),
    unprofitable: r.netPnl < 0,
  }));
}

/**
 * The parameter sweep grid.
 *
 * Billed once per market-day, not per cell: the archive is decoded once and
 * every cell is evaluated against the same decoded stream. Charging per cell
 * would be charging for our CPU rather than for data scanned.
 */
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
 * Assemble the whole report.
 *
 * `coverage` is carried through untouched from the archive: which stream backed
 * each market-day, and where the gaps were. It is the part of the report that
 * makes the rest of it checkable, so it is never summarised away.
 */
export function buildReport({
  runId, submittedAt, manifest, scope,
  trades, fills, marketSummaries, marketMeta,
  feesPaid = 0, latency = [], sweep = null, coverage = null,
  crosschecks = [], budget = null, seed = null, scanned = {},
}) {
  const closed = trades.filter((t) => Number.isFinite(t.pnl));
  const equity = equityCurve(closed);
  const matched = crosschecks.filter((c) => c.match).length;

  return {
    run_id: runId,
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
    equity: equity.map((p) => ({ ts_ms: p.ts_ms, equity: r2(p.equity) })),
    crosscheck: {
      markets_touched: new Set(closed.map((t) => t.market_id)).size,
      recompute_checks: crosschecks.length,
      recompute_matches: matched,
      // Reported even when zero checks were made — a blank panel would read as
      // "everything reconciled".
      mismatches: crosschecks.length - matched,
    },
    trades: closed,
    fills,
    calibration: calibration(closed),
    // Same markets, same sizing — the average size the strategy actually
    // traded, so the comparison is like for like.
    baselines: baselines(marketSummaries ?? [], {
      size: closed.length ? closed.reduce((a, t) => a + (t.size ?? 0), 0) / closed.length : 1,
    }),
    split: splitByMarket(closed, marketMeta ?? new Map()),
    slippage: slippage(fills ?? []),
    latency: latencyPanel(latency),
    sweep,
    coverage,
    budget,
  };
}
