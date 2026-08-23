import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  metrics, brier, edgePerContract, equityCurve, maxDrawdown, worstLosingRun,
  calibration, baselines, slippage, splitByMarket, latencyPanel, sweepPanel,
  buildReport, LATENCY_STEPS,
} from './report.mjs';

const day = (d) => Date.parse(`2026-07-${String(d).padStart(2, '0')}T12:00:00Z`);

/** A settled trade. `won` decides the outcome relative to the side taken. */
const settled = ({ px, size = 100, won, d = 1, side = 'UP', market = '0xa' }) => ({
  market_id: market,
  side,
  size,
  entry_px: px,
  exit_px: won ? 1 : 0,
  pnl: (won ? 1 - px : -px) * size,
  fees: 0,
  opened_ms: day(d) - 60_000,
  closed_ms: day(d),
  how: 'settled',
  outcome: won ? side : (side === 'UP' ? 'DOWN' : 'UP'),
});

// ---------------------------------------------------------------------------
// headline metrics
// ---------------------------------------------------------------------------

test('net pnl, win rate and trade count come straight off the trades', () => {
  const trades = [
    settled({ px: 0.5, won: true, d: 1 }),
    settled({ px: 0.5, won: false, d: 2 }),
    settled({ px: 0.4, won: true, d: 3 }),
  ];
  const m = metrics(trades);
  assert.equal(m.trades, 3);
  assert.equal(m.net_pnl, 50 - 50 + 60);
  assert.equal(m.win_rate, 0.6667);
});

test('profit factor is gross win over gross loss, and blank with no losses', () => {
  const winners = [settled({ px: 0.5, won: true, d: 1 }), settled({ px: 0.5, won: true, d: 2 })];
  // Infinity would print as a number nobody can compare; a blank is honest.
  assert.equal(metrics(winners).profit_factor, null);

  const mixed = [...winners, settled({ px: 0.5, won: false, d: 3 })];
  assert.equal(metrics(mixed).profit_factor, 2);
});

test('an empty run reports blanks rather than zeros that look like results', () => {
  const m = metrics([]);
  assert.equal(m.trades, 0);
  assert.equal(m.net_pnl, 0);
  assert.equal(m.win_rate, null);
  assert.equal(m.sharpe, null);
  assert.equal(m.brier_score, null);
  assert.equal(m.return_on_collateral, null);
});

test('return on collateral divides by what was actually tied up', () => {
  // 100 contracts at 0.50 = $50 deployed, $50 made.
  const m = metrics([settled({ px: 0.5, won: true, d: 1 })]);
  assert.equal(m.collateral_deployed, 50);
  assert.equal(m.return_on_collateral, 1);
});

test('fees are reported as a negative number', () => {
  assert.equal(metrics([], { feesPaid: 188 }).fees, -188);
  assert.equal(metrics([], { feesPaid: -188 }).fees, -188);
});

// ---------------------------------------------------------------------------
// scoring the forecast
// ---------------------------------------------------------------------------

test('brier scores the price as a forecast', () => {
  // Paid 0.5 and won: (0.5 - 1)^2 = 0.25. Paid 0.5 and lost: same.
  // brier() returns the raw value so it can feed further arithmetic; metrics()
  // is the layer that rounds for display.
  const b = (t) => Number(brier(t).toFixed(4));
  assert.equal(b([settled({ px: 0.5, won: true, d: 1 })]), 0.25);
  // A confident, correct call scores well.
  assert.equal(b([settled({ px: 0.9, won: true, d: 1 })]), 0.01);
  // A confident, wrong one scores badly.
  assert.equal(b([settled({ px: 0.9, won: false, d: 1 })]), 0.81);
  assert.equal(brier([]), null);
  assert.equal(metrics([settled({ px: 0.9, won: true, d: 1 })]).brier_score, 0.01);
});

test('edge per contract is realised outcome minus price paid', () => {
  assert.equal(Number(edgePerContract([settled({ px: 0.4, won: true, d: 1 })]).toFixed(4)), 0.6);
  assert.equal(Number(edgePerContract([settled({ px: 0.4, won: false, d: 1 })]).toFixed(4)), -0.4);
});

test('trades closed before settlement are excluded from edge and brier', () => {
  // Exiting early is edge against the market, not against the truth. Scoring
  // it as a forecast would be measuring something that never resolved.
  const early = {
    market_id: '0xa', side: 'UP', size: 100, entry_px: 0.5, exit_px: 0.6,
    pnl: 10, fees: 0, opened_ms: day(1) - 1000, closed_ms: day(1), how: 'exit',
  };
  assert.equal(brier([early]), null);
  assert.equal(edgePerContract([early]), 0);
  // ...but it still counts toward PnL and the trade count.
  assert.equal(metrics([early]).net_pnl, 10);
  assert.equal(metrics([early]).trades, 1);
});

// ---------------------------------------------------------------------------
// equity and drawdown
// ---------------------------------------------------------------------------

test('the equity curve accumulates in close order, not submission order', () => {
  const curve = equityCurve([
    { pnl: 10, closed_ms: 300 },
    { pnl: -5, closed_ms: 100 },
    { pnl: 20, closed_ms: 200 },
  ]);
  assert.deepEqual(curve.map((p) => p.equity), [-5, 15, 25]);
});

test('drawdown is measured against the running peak', () => {
  const dd = maxDrawdown([0, 100, 60, 120, 40]);
  assert.equal(dd.abs, 80);          // 120 -> 40
  assert.equal(Number(dd.pct.toFixed(4)), -0.6667);
});

test('a curve that never turns positive reports an absolute decline only', () => {
  // Dividing by a peak of zero would print a percentage in the thousands.
  const dd = maxDrawdown([0, -10, -50]);
  assert.equal(dd.abs, 50);
  assert.equal(dd.pct, null);
});

test('the worst losing run counts consecutive losers', () => {
  assert.equal(worstLosingRun([1, -1, -1, -1, 2, -1, -1]), 3);
  assert.equal(worstLosingRun([1, 2, 3]), 0);
  assert.equal(worstLosingRun([]), 0);
});

test('sharpe needs more than one day of returns', () => {
  const oneDay = [settled({ px: 0.5, won: true, d: 1 })];
  assert.equal(metrics(oneDay).sharpe, null);

  const spread = [
    settled({ px: 0.5, won: true, d: 1 }),
    settled({ px: 0.5, won: false, d: 2 }),
    settled({ px: 0.4, won: true, d: 3 }),
  ];
  assert.ok(Number.isFinite(metrics(spread).sharpe));
});

// ---------------------------------------------------------------------------
// calibration
// ---------------------------------------------------------------------------

test('calibration compares what was paid with what settled', () => {
  // Four trades in the 0.4-0.5 bucket, three of which won.
  const trades = [
    settled({ px: 0.45, won: true, d: 1 }),
    settled({ px: 0.45, won: true, d: 2 }),
    settled({ px: 0.45, won: true, d: 3 }),
    settled({ px: 0.45, won: false, d: 4 }),
  ];
  const rows = calibration(trades);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bucket, '0.40 – 0.50');
  assert.equal(rows[0].implied, 0.45);
  assert.equal(rows[0].realized, 0.75);
  assert.equal(rows[0].edge_cents, 30);
  assert.equal(rows[0].trades, 4);
});

test('empty buckets are omitted, not reported as zero edge', () => {
  const rows = calibration([settled({ px: 0.55, won: true, d: 1 })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bucket, '0.50 – 0.60');
});

// ---------------------------------------------------------------------------
// baselines
// ---------------------------------------------------------------------------

test('naive baselines price the same markets the strategy saw', () => {
  const markets = [
    { outcome: 'UP', up_px: 0.40, down_px: 0.62 },
    { outcome: 'DOWN', up_px: 0.55, down_px: 0.47 },
  ];
  const b = baselines(markets, { size: 1 });
  // always UP: (1-0.40) + (0-0.55) = 0.05
  assert.equal(b.always_up, 0.05);
  // always DOWN: (0-0.62) + (1-0.47) = -0.09
  assert.equal(b.always_down, -0.09);
  // The favourite is the DEARER side, because on a binary market the price is
  // the implied probability. Market 1: DOWN at 0.62 (lost). Market 2: UP at
  // 0.55 (lost). This test previously codified the inverted version, which is
  // how the panel came to compare strategies against buying the underdog.
  assert.equal(b.always_favourite, Number(((0 - 0.62) + (0 - 0.55)).toFixed(2)));
});

test('the favourite is the side the market thinks will win', () => {
  // A market priced UP 0.70 / DOWN 0.30 that settles UP: buying the favourite
  // made money. The inverted version reported a loss of 0.30 on a call the
  // market got right.
  const b = baselines([{ outcome: 'UP', up_px: 0.70, down_px: 0.30 }], { size: 1 });
  assert.equal(b.always_favourite, 0.30);

  const lost = baselines([{ outcome: 'DOWN', up_px: 0.70, down_px: 0.30 }], { size: 1 });
  assert.equal(lost.always_favourite, -0.70);
});

test('markets with no outcome are skipped rather than counted as losses', () => {
  const b = baselines([{ outcome: null, up_px: 0.4, down_px: 0.6 }]);
  assert.equal(b.always_up, 0);
});

// ---------------------------------------------------------------------------
// slippage
// ---------------------------------------------------------------------------

test('slippage separates paying up from not getting filled', () => {
  const fills = [
    { action: 'open', requested: 100, filled: 100, unfilled: 0, quoted_px: 0.50, avg_px: 0.50, levels_walked: 1 },
    { action: 'open', requested: 100, filled: 100, unfilled: 0, quoted_px: 0.50, avg_px: 0.52, levels_walked: 3 },
    { action: 'open', requested: 100, filled: 0, unfilled: 100, quoted_px: 0.50, avg_px: null, levels_walked: 0 },
    { action: 'open', requested: 100, filled: 100, unfilled: 0, quoted_px: 0.50, avg_px: 0.51, levels_walked: 2 },
  ];
  const s = slippage(fills);
  assert.equal(s.orders, 4);
  assert.equal(s.fills_at_quote, 0.25);
  assert.equal(s.partial_fills, 0.5);
  assert.equal(s.unfilled, 0.25);
  // Money not kept, so negative.
  assert.equal(s.pnl_lost_to_slippage, -3);
  assert.equal(s.unfilled_size_ratio, 0.25);
});

test('exits are not counted as slippage on entry', () => {
  const s = slippage([
    { action: 'reduce', requested: 100, filled: 100, unfilled: 0, quoted_px: 0.49, avg_px: 0.49, levels_walked: 1 },
  ]);
  assert.equal(s.orders, 0);
  assert.equal(s.fills_at_quote, null);
});

// ---------------------------------------------------------------------------
// panels
// ---------------------------------------------------------------------------

test('the split groups by asset and market period', () => {
  const meta = new Map([
    ['0xa', { asset: 'BTC', interval: '1h' }],
    ['0xb', { asset: 'ETH', interval: '15m' }],
  ]);
  const rows = splitByMarket([
    { market_id: '0xa', pnl: 100 },
    { market_id: '0xa', pnl: 50 },
    { market_id: '0xb', pnl: -20 },
  ], meta);
  assert.deepEqual(rows, [
    { name: 'BTC 1h', pnl: 150, trades: 2 },
    { name: 'ETH 15m', pnl: -20, trades: 1 },
  ]);
});

test('the latency panel is relative to the as-captured run', () => {
  const rows = latencyPanel([
    { delayMs: 0, netPnl: 1000 },
    { delayMs: 250, netPnl: 500 },
    { delayMs: 2000, netPnl: -100 },
  ]);
  assert.equal(rows[0].label, LATENCY_STEPS[0].label);
  assert.equal(rows[1].ratio, 0.5);
  assert.equal(rows[2].unprofitable, true);
  assert.equal(rows[0].unprofitable, false);
});

test('the sweep grid is laid out by the two swept params', () => {
  const cells = [];
  for (const z of [1.0, 2.0]) {
    for (const hold of [10, 20, 30]) {
      cells.push({ params: { entry_z: z, hold_minutes: hold }, metrics: { sharpe: z * hold / 10 } });
    }
  }
  const s = sweepPanel(cells, { xParam: 'hold_minutes', yParam: 'entry_z', metric: 'sharpe' });
  assert.deepEqual(s.x_labels, [10, 20, 30]);
  assert.deepEqual(s.y_labels, [1.0, 2.0]);
  assert.deepEqual(s.grid, [[1, 2, 3], [2, 4, 6]]);
  assert.equal(s.max, 6);
  assert.equal(s.cells, 6);
});

test('a sweep with a missing cell leaves a hole rather than a zero', () => {
  const s = sweepPanel([
    { params: { a: 1, b: 1 }, metrics: { sharpe: 5 } },
    { params: { a: 2, b: 2 }, metrics: { sharpe: 7 } },
  ], { xParam: 'a', yParam: 'b', metric: 'sharpe' });
  assert.deepEqual(s.grid, [[5, null], [null, 7]]);
});

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

test('the report carries coverage through untouched', () => {
  const coverage = { days: [{ day: '2026-07-01', stream: 'prices', gaps: 0 }] };
  const r = buildReport({
    runId: 'run_abc123',
    submittedAt: 1,
    manifest: { schema: 1, language: 'python@3.14', mode: 'market' },
    scope: { venue: 'polymarket', assets: ['BTC'], from: '2026-07-01', to: '2026-07-01', archivedDayCount: 1 },
    trades: [settled({ px: 0.5, won: true, d: 1 })],
    fills: [],
    marketSummaries: [],
    coverage,
  });
  assert.deepEqual(r.coverage, coverage, 'coverage is what makes the rest checkable');
  assert.equal(r.run_id, 'run_abc123');
  assert.equal(r.metrics.net_pnl, 50);
});

test('a clean cross-check and a missing one look different', () => {
  const base = {
    runId: 'r', submittedAt: 1, manifest: {}, scope: {},
    trades: [settled({ px: 0.5, won: true, d: 1 })], fills: [], marketSummaries: [],
  };
  const none = buildReport(base);
  assert.equal(none.crosscheck.recompute_checks, 0);
  assert.equal(none.crosscheck.mismatches, 0);

  const bad = buildReport({ ...base, crosschecks: [{ match: true }, { match: false }] });
  assert.equal(bad.crosscheck.recompute_matches, 1);
  assert.equal(bad.crosscheck.mismatches, 1);
});
