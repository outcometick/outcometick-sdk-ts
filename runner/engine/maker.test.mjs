// Resting orders, against hand-computed answers.
//
// Every expected number below was worked out on paper from the rules at the top
// of maker.mjs, not read back from the engine. runner/conformance runs the same
// shapes through both engines; this file is what says the shared answer is the
// RIGHT one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayMarket, RunAbort } from './replay.mjs';
import { Portfolio } from './portfolio.mjs';
import { PRINT_LAG_MS, canonicalOf, canonicalPrint, MAX_RESTING } from './maker.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

const HOOKS = { on_tick: 'on_tick', on_book: 'on_book', on_trade: 'on_trade', on_settle: 'on_settle' };
const MARKET = { market_id: '0xm', asset: 'BTC', outcome: 'UP', close_ts_ms: 100_000 };
const ALLOW = { allowed: true, refusal: null, cancelLatencyMs: 0 };

/** A mirrored book: UP ladders given, DOWN derived exactly as the venue publishes it. */
const mirror = (ts, upBids, upAsks) => ({
  kind: 'book', ts_ms: ts, snapshot: true,
  levels: {
    UP: { bids: upBids, asks: upAsks },
    DOWN: {
      bids: upAsks.map(([p, s]) => [Number((1 - p).toFixed(4)), s]),
      asks: upBids.map(([p, s]) => [Number((1 - p).toFixed(4)), s]),
    },
  },
});
const tick = (ts, value) => ({ kind: 'tick', ts_ms: ts, market_id: '0xm', value });
const trade = (ts, side, taker, px, size) => ({ kind: 'trade', ts_ms: ts, market_id: '0xm', side, taker, px, size });
const delta = (ts, side, ladder, px, size) => ({ kind: 'book', ts_ms: ts, side, ladder, px, size });

/**
 * A strategy that does what `plan[tick.value]` says: an order (or list), or a
 * function of ctx. Ticks are the script's clock.
 */
function scripted(plan) {
  return {
    seen: [],
    on_tick(ctx, t) {
      const step = plan[t.value];
      if (typeof step === 'function') return step(ctx);
      return step ?? null;
    },
  };
}

function run({ events, plan, resting = ALLOW, fillDelayMs = 0, market = MARKET, portfolio = null }) {
  const pf = portfolio ?? new Portfolio({ fees: { mode: 'venue' } });
  const out = replayMarket({ market, events, strategy: scripted(plan), hooks: HOOKS, portfolio: pf, fillDelayMs, resting });
  return { out, pf, maker: out.maker, fills: pf.fills };
}

const makerFills = (fills) => fills.filter((f) => f.liquidity === 'maker');

test('canonical mapping: one queue for both tokens', () => {
  assert.deepEqual(canonicalOf('UP', false, 4000), { kind: 'bids', q: 4000 });
  assert.deepEqual(canonicalOf('UP', true, 4500), { kind: 'asks', q: 4500 });
  assert.deepEqual(canonicalOf('DOWN', false, 5500), { kind: 'asks', q: 4500 });
  assert.deepEqual(canonicalOf('DOWN', true, 6000), { kind: 'bids', q: 4000 });
  // A DOWN buyer at 0.60 is an UP seller at 0.40: it consumes canonical bids.
  assert.deepEqual(canonicalPrint({ side: 'DOWN', taker: 'BUY', px: 0.6 }), { kind: 'bids', p: 4000 });
  assert.deepEqual(canonicalPrint({ side: 'UP', taker: 'BUY', px: 0.45 }), { kind: 'asks', p: 4500 });
});

test('joins behind the visible size; prints on BOTH tokens advance it; the entry window ignores early prints', () => {
  // Bid UP 50 @ 0.40 behind 100. Activated at 1000 (decided at 1000, latency 0,
  // drained at the next event). Eligible from 1000 + PRINT_LAG_MS = 1800.
  const { maker, fills, pf } = run({
    events: [
      mirror(1000, [[0.40, 100]], [[0.45, 200]]),
      tick(1000, 1),
      tick(1100, 0),
      // 1500 < 1800: ignored for the order — no fill, queue unchanged. The 30
      // still goes through the waterfall against the 100 in front, so nothing
      // is suppressed either.
      trade(1500, 'DOWN', 'BUY', 0.60, 30),
      // 2000: an UP seller hits 0.40 for 120 → 100 in front, then 20 to us.
      trade(2000, 'UP', 'SELL', 0.40, 120),
      // 2100: a DOWN buyer at 0.60 is the same queue → the remaining 30.
      trade(2100, 'DOWN', 'BUY', 0.60, 40),
    ],
    plan: { 1: { side: 'UP', size: 50, limit: 0.40, tif: 'gtc' } },
  });
  assert.equal(PRINT_LAG_MS, 800);
  const mf = makerFills(fills);
  assert.deepEqual(mf.map((f) => [f.ts_ms, f.filled, f.avg_px]), [[2000, 20, 0.40], [2100, 30, 0.40]]);
  assert.deepEqual(mf.map((f) => f.queue_ahead_at_fill), [100, 0]);
  assert.equal(mf[0].queue_ahead_at_join, 100);
  assert.equal(mf[0].time_in_queue_ms, 1000);
  assert.equal(mf[0].fee, 0);
  assert.equal(maker.fully_filled, 1);
  assert.equal(maker.maker_filled_size, 50);
  assert.equal(maker.lag_suppressed_size, 0);
  // Settled UP: 50 × (1 − 0.40) = 30, no fees.
  near(pf.trades[0].pnl, 30);
});

test('a trade the book showed first is deducted once, at its price (ledger)', () => {
  // Eligible bid UP 50 @ 0.40 behind 100. The book drops the level to 70 at
  // 2000 (ahead → 70, ledger 30). The print of that same trade at 2050 meets
  // the ledger first: no fill, ahead stays 70. A later 80 → 70 in front, 10 to us.
  const { fills } = run({
    events: [
      mirror(1000, [[0.40, 100]], [[0.45, 200]]),
      tick(1000, 1),
      tick(1100, 0),
      delta(2000, 'UP', 'bids', 0.40, 70),
      trade(2050, 'UP', 'SELL', 0.40, 30),
      trade(2100, 'UP', 'SELL', 0.40, 80),
    ],
    plan: { 1: { side: 'UP', size: 50, limit: 0.40, tif: 'gtc' } },
  });
  assert.deepEqual(makerFills(fills).map((f) => [f.ts_ms, f.filled, f.queue_ahead_at_fill]), [[2100, 10, 70]]);
});

test('depth removed at a BETTER price before the print still has priority (no fill)', () => {
  // Buy DOWN 100 @ 0.50 = canonical ask 0.50. UP asks: 100 @ 0.40, 1 @ 0.50.
  // Both vanish before a print UP BUY 0.50 × 101 arrives: the 100 at 0.40 and
  // the 1 at 0.50 still come first. Nothing reaches us.
  const { fills, maker } = run({
    events: [
      mirror(1000, [[0.30, 10]], [[0.40, 100], [0.50, 1]]),
      tick(1000, 1),
      tick(1100, 0),
      delta(2000, 'UP', 'asks', 0.40, 0),
      delta(2000, 'UP', 'asks', 0.50, 0),
      trade(2050, 'UP', 'BUY', 0.50, 101),
    ],
    plan: { 1: { side: 'DOWN', size: 100, limit: 0.50, tif: 'gtc' } },
  });
  assert.equal(makerFills(fills).length, 0);
  assert.equal(maker.rested, 1);
});

test('a print reaches only prices at least as good as its own', () => {
  // Bid UP 10 @ 0.40, nothing in front. A seller prints 0.41: it may have
  // been the best price of a sweep, so 0.40 is not known to be reached.
  // A seller at 0.39 does reach 0.40 (we are better than where it traded).
  const { fills } = run({
    events: [
      mirror(1000, [[0.38, 100]], [[0.45, 200]]),
      tick(1000, 1),
      tick(1100, 0),
      trade(2000, 'UP', 'SELL', 0.41, 50),
      trade(2100, 'UP', 'SELL', 0.39, 4),
    ],
    plan: { 1: { side: 'UP', size: 10, limit: 0.40, tif: 'gtc' } },
  });
  assert.deepEqual(makerFills(fills).map((f) => [f.ts_ms, f.filled]), [[2100, 4]]);
});

test('cancel before activation never rests; cancel after rests through the exposure window', () => {
  // Order A: decided at 1000 with entry latency 1000 → activation 2000.
  // Cancelled at 1100 with cancel latency 100 → effective 1200 < 2000:
  // never reaches the venue.
  const a = run({
    events: [mirror(1000, [[0.40, 100]], [[0.45, 200]]), tick(1000, 1), tick(1100, 2), tick(3000, 0)],
    plan: {
      1: { side: 'UP', size: 10, limit: 0.40, tif: 'gtc', client_id: 'a' },
      2: (ctx) => { assert.equal(ctx.cancel('a'), true); return null; },
    },
    fillDelayMs: 1000,
    resting: { allowed: true, cancelLatencyMs: 100 },
  });
  assert.equal(a.maker.cancelled_before_entry, 1);
  assert.equal(a.maker.rested, 0);

  // Order B: live and eligible; cancel effective at 3000. A print at 3700
  // (≤ 3000 + 800) still fills it; one at 3900 finds it cancelled.
  const b = run({
    events: [
      mirror(1000, [[0.40, 1]], [[0.45, 200]]),
      tick(1000, 1),
      tick(1100, 0),
      tick(3000, 2),
      tick(3001, 0),
      trade(3700, 'UP', 'SELL', 0.40, 5),
      trade(3900, 'UP', 'SELL', 0.40, 5),
    ],
    plan: {
      1: { side: 'UP', size: 10, limit: 0.40, tif: 'gtc', client_id: 'b' },
      2: (ctx) => {
        const view = ctx.orders();
        assert.equal(view.length, 1);
        assert.equal(view[0].state, 'live');
        assert.equal(view[0].id, 'o1');
        ctx.cancel('o1');
        return null;
      },
    },
  });
  // 3700: 1 in front, 4 to us. 3900: cancelled at finalize (3000 + 800 < 3900).
  assert.deepEqual(makerFills(b.fills).map((f) => [f.ts_ms, f.filled]), [[3700, 4]]);
  assert.equal(b.maker.cancelled, 1);
});

test('marketable on arrival: post_only is rejected; otherwise the crossing part takes and the rest rests', () => {
  const p = run({
    events: [mirror(1000, [[0.40, 100]], [[0.45, 20]]), tick(1000, 1), tick(1100, 0)],
    plan: { 1: { side: 'UP', size: 50, limit: 0.45, tif: 'gtc', post_only: true } },
  });
  assert.equal(p.maker.rejected_post_only, 1);
  assert.equal(p.fills.length, 0);

  // Bid 50 @ 0.45 against 20 offered at 0.45: 20 taken (taker fee), 30 rest at
  // 0.45 with nothing in front of them on the bid side.
  const fee = { model: 'polymarket-taker-v1', rate: 0.07 };
  const t = run({
    market: { ...MARKET, fee },
    events: [
      mirror(1000, [[0.40, 100]], [[0.45, 20]]),
      tick(1000, 1),
      tick(1100, 0),
      trade(2000, 'DOWN', 'BUY', 0.55, 30),
    ],
    plan: { 1: { side: 'UP', size: 50, limit: 0.45, tif: 'gtc' } },
  });
  const taker = t.fills.filter((f) => f.liquidity === 'taker');
  assert.deepEqual(taker.map((f) => [f.filled, f.avg_px, f.order_id]), [[20, 0.45, 'o1']]);
  // round5(20 × 0.07 × 0.45 × 0.55) = 0.3465
  near(taker[0].fee, 0.3465);
  assert.equal(t.maker.taker_on_arrival_size, 20);
  assert.equal(t.maker.rested_size, 30);
  // The book has no bid at 0.45 (the 20 we took were asks): ahead 0. The DOWN
  // buyer at 0.55 consumes canonical bids at 0.45 → all 30 to us, at 0.45, no fee.
  assert.deepEqual(makerFills(t.fills).map((f) => [f.filled, f.avg_px, f.fee, f.queue_ahead_at_join]), [[30, 0.45, 0, 0]]);
});

test('reduce-only resting ask sells only what is open, then stops for good', () => {
  // Buy 10 UP by IOC at 0.45, then rest a reduce-only ask for 25 at 0.50.
  // A buyer prints 0.50 × 100 (canonical ask 0.50, nothing in front): 10 fill
  // (the open position), and the order is done.
  const { fills, maker, pf } = run({
    events: [
      mirror(1000, [[0.40, 100]], [[0.45, 100]]),
      tick(1000, 1),
      tick(1100, 2),
      tick(1200, 0),
      trade(2500, 'UP', 'BUY', 0.50, 100),
      trade(2600, 'UP', 'BUY', 0.50, 100),
    ],
    plan: {
      1: { side: 'UP', size: 10, limit: 0.45 },
      2: { side: 'UP', size: 25, limit: 0.50, tif: 'gtc', reduce_only: true },
    },
  });
  // normalize clamps a reduce-only order to the open leg at activation: 10.
  assert.deepEqual(makerFills(fills).map((f) => [f.filled, f.action, f.avg_px]), [[10, 'reduce', 0.50]]);
  assert.equal(maker.fully_filled, 1);
  near(pf.trades[0].pnl, 10 * (0.50 - 0.45));
});

test('our own orders may not cross each other', () => {
  // Bid UP @ 0.60 = canonical bid 0.60. Bid DOWN @ 0.50 = canonical ask 0.50:
  // it would trade with our own bid. Rejected.
  const { maker } = run({
    events: [mirror(1000, [[0.40, 100]], [[0.70, 100]]), tick(1000, 1), tick(1100, 2), tick(1200, 0)],
    plan: {
      1: { side: 'UP', size: 5, limit: 0.60, tif: 'gtc' },
      2: { side: 'DOWN', size: 5, limit: 0.50, tif: 'gtc' },
    },
  });
  assert.equal(maker.rested, 1);
  assert.equal(maker.rejected_self_cross, 1);
});

test('a just-cancelled order does not block a re-quote through its price', () => {
  // Bid UP @ 0.43 live; cancelled at 1500 (latency 0) → cancel_pending, still
  // exposed until 2300. A DOWN bid @ 0.59 (canonical ask 0.41) placed at 1600
  // would cross the old bid — but that bid has left the venue. Accepted.
  const { maker } = run({
    events: [mirror(1000, [[0.40, 100]], [[0.45, 100]]), tick(1000, 1), tick(1500, 2), tick(1600, 3), tick(1700, 0)],
    plan: {
      1: { side: 'UP', size: 5, limit: 0.43, tif: 'gtc', client_id: 'old' },
      2: (ctx) => { ctx.cancel('old'); return null; },
      3: { side: 'DOWN', size: 5, limit: 0.59, tif: 'gtc' },
    },
  });
  assert.equal(maker.rejected_self_cross, 0);
  assert.equal(maker.rested, 2);
});

test('own orders share the queue: the earlier one is in front, one print never fills more than it printed', () => {
  // Two bids at 0.40 (UP 10, then DOWN reduce? no — keep both UP), 5 visible in front.
  const { fills } = run({
    events: [
      mirror(1000, [[0.40, 5]], [[0.45, 100]]),
      tick(1000, 1),
      tick(1001, 2),
      tick(1100, 0),
      trade(3000, 'UP', 'SELL', 0.40, 12),
    ],
    plan: {
      1: { side: 'UP', size: 10, limit: 0.40, tif: 'gtc' },
      2: { side: 'UP', size: 10, limit: 0.40, tif: 'gtc' },
    },
  });
  // 12 printed: 5 external in front of both, 7 to the first order, 0 left for the second.
  assert.deepEqual(makerFills(fills).map((f) => [f.order_id, f.filled]), [['o1', 7]]);
});

test('markouts: mid of the fill token at the horizon, null when stale or past the close; settle markout', () => {
  const { fills } = run({
    market: { ...MARKET, close_ts_ms: 70_000 },
    events: [
      mirror(1000, [[0.40, 0]], [[0.45, 100]]),
      tick(1000, 1),
      tick(1100, 0),
      trade(2000, 'UP', 'SELL', 0.40, 10),
      // 2900: book moves — UP mid (0.42 + 0.46) / 2 = 0.44 at the 1s horizon (3000).
      mirror(2900, [[0.42, 50]], [[0.46, 50]]),
      // 11000: the 10s horizon (12000) sees this book, 1000ms old: fresh.
      mirror(11000, [[0.30, 50]], [[0.34, 50]]),
      // Nothing for UP after 11000 until the 60s horizon (62000): stale → null.
      tick(65000, 0),
    ],
    plan: { 1: { side: 'UP', size: 10, limit: 0.40, tif: 'gtc' } },
  });
  const [f] = makerFills(fills);
  near(f.markout_1s, 0.44 - 0.40);
  near(f.markout_10s, 0.32 - 0.40);
  assert.equal(f.markout_60s, null);
  // Settled UP: worth 1, bought at 0.40.
  near(f.markout_settle, 0.60);
});

test('everything not final expires at the close, pending entries included', () => {
  const { maker, fills } = run({
    market: { ...MARKET, close_ts_ms: 5000 },
    events: [mirror(1000, [[0.40, 100]], [[0.45, 100]]), tick(1000, 1), tick(1100, 0), tick(4900, 2)],
    plan: {
      1: { side: 'UP', size: 10, limit: 0.40, tif: 'gtc' },
      // Decided at 4900 with latency 1000 → would activate at 5900, after the close.
      2: { side: 'UP', size: 10, limit: 0.39, tif: 'gtc' },
    },
    fillDelayMs: 1000,
  });
  assert.equal(maker.expired, 2);
  assert.equal(makerFills(fills).length, 0);
});

test('refusals: not allowed, hold_s, off-grid limit, missing limit, reserved client_id, too many orders', () => {
  const ev = [mirror(1000, [[0.40, 100]], [[0.45, 100]]), tick(1000, 1), tick(1100, 0)];
  assert.throws(
    () => run({ events: ev, plan: { 1: { side: 'UP', size: 1, limit: 0.4, tif: 'gtc' } }, resting: { allowed: false, refusal: 'no trades declared' } }),
    (e) => e instanceof RunAbort && e.code === 'E_MANIFEST' && /no trades declared/.test(e.detail),
  );
  assert.throws(
    () => run({ events: ev, plan: { 1: { side: 'UP', size: 1, limit: 0.4, tif: 'gtc', hold_s: 5 } } }),
    (e) => e instanceof RunAbort && e.code === 'E_MANIFEST',
  );
  const grid = run({ events: ev, plan: { 1: [
    { side: 'UP', size: 1, limit: 0.4005, tif: 'gtc' },
    { side: 'UP', size: 1, tif: 'gtc' },
    { side: 'UP', size: 1, limit: 0.4, tif: 'gtc', client_id: 'o7' },
  ] } });
  assert.equal(grid.maker.rejected_invalid, 3);
  assert.throws(
    () => run({ events: ev, plan: { 1: Array.from({ length: MAX_RESTING + 1 }, (_, i) => ({ side: 'UP', size: 1, limit: 0.30 - i * 0.001, tif: 'gtc' })) } }),
    (e) => e instanceof RunAbort && /resting orders/.test(e.detail),
  );
});

test('IOC rows carry liquidity "taker" and the same numbers as before', () => {
  const { fills } = run({
    events: [mirror(1000, [[0.40, 100]], [[0.45, 100]]), tick(1000, 1), tick(1100, 0)],
    plan: { 1: { side: 'UP', size: 10, limit: 0.45 } },
    resting: null,
  });
  assert.deepEqual(fills.map((f) => [f.liquidity, f.order_id, f.filled, f.avg_px]), [['taker', null, 10, 0.45]]);
});
