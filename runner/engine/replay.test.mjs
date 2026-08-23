import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayMarket, BudgetMonitor, RunAbort, makeRng } from './replay.mjs';
import { Portfolio } from './portfolio.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

const HOOKS = {
  on_market_open: 'on_market_open',
  on_tick: 'on_tick',
  on_book: 'on_book',
  on_trade: 'on_trade',
  on_settle: 'on_settle',
};

const MARKET = {
  market_id: '0xm', asset: 'BTC', strike: 65000, outcome: 'UP', close_ts_ms: 10_000,
};

/** A book snapshot event. */
const snap = (ts, up = { asks: [[0.50, 1000]], bids: [[0.49, 1000]] }, down = { asks: [[0.51, 1000]], bids: [[0.50, 1000]] }) =>
  ({ kind: 'book', ts_ms: ts, snapshot: true, levels: { UP: up, DOWN: down } });

const tick = (ts, value) => ({ kind: 'tick', ts_ms: ts, market_id: '0xm', value, source: 'prices' });

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

test('hooks fire in event-time order and only the declared ones', () => {
  const seen = [];
  const strategy = {
    on_market_open(ctx, m) { seen.push(['open', m.market_id]); },
    on_tick(ctx, t) { seen.push(['tick', t.ts_ms]); },
    on_trade() { seen.push(['trade']); },
    on_settle(ctx, m, o) { seen.push(['settle', o]); },
  };
  replayMarket({
    market: MARKET,
    events: [snap(1000), tick(1001, 1), tick(1002, 2), { kind: 'trade', ts_ms: 1003 }],
    strategy,
    // on_trade is NOT declared, so it must never be called.
    hooks: { on_market_open: 'on_market_open', on_tick: 'on_tick', on_settle: 'on_settle' },
  });
  assert.deepEqual(seen, [
    ['open', '0xm'], ['tick', 1001], ['tick', 1002], ['settle', 'UP'],
  ]);
});

test('a strategy can only see ticks it has already been given', () => {
  const depths = [];
  const strategy = {
    on_tick(ctx) { depths.push(ctx.history(100).length); },
  };
  replayMarket({
    market: MARKET,
    events: [tick(1, 1), tick(2, 2), tick(3, 3)],
    strategy,
    hooks: { on_tick: 'on_tick' },
  });
  // Look-ahead is impossible: the history grows one row at a time.
  assert.deepEqual(depths, [1, 2, 3]);
});

test('the book a strategy reads is the one resting at that millisecond', () => {
  const prices = [];
  const strategy = { on_tick(ctx) { prices.push(ctx.book().best('UP')); } };
  replayMarket({
    market: MARKET,
    events: [
      snap(1, { asks: [[0.50, 100]], bids: [[0.49, 100]] }),
      tick(2, 1),
      snap(3, { asks: [[0.70, 100]], bids: [[0.69, 100]] }),
      tick(4, 1),
    ],
    strategy,
    hooks: { on_tick: 'on_tick' },
  });
  assert.deepEqual(prices, [0.50, 0.70]);
});

// ---------------------------------------------------------------------------
// orders
// ---------------------------------------------------------------------------

test('a returned order is matched, and held to settlement by default', () => {
  const pf = new Portfolio();
  let sent = false;
  const strategy = {
    on_tick() {
      if (sent) return null;
      sent = true;
      return { side: 'UP', size: 100, limit: 0.55 };
    },
  };
  const res = replayMarket({
    market: MARKET, events: [snap(1000), tick(1001, 1), tick(1002, 1)],
    strategy, hooks: { on_tick: 'on_tick' }, portfolio: pf,
  });
  assert.equal(res.settled.length, 1);
  near(res.settled[0].pnl, 100 * (1 - 0.50));
});

test('returning a list closes and reverses in one event', () => {
  const pf = new Portfolio();
  let step = 0;
  const strategy = {
    on_tick() {
      step += 1;
      if (step === 1) return { side: 'UP', size: 100, limit: 1 };
      if (step === 2) {
        return [
          { side: 'UP', size: 100, limit: null, reduce_only: true },
          { side: 'DOWN', size: 100, limit: 1 },
        ];
      }
      return null;
    },
  };
  // outcome null so nothing settles — the point here is the position the two
  // orders left behind, not what it was eventually worth.
  replayMarket({
    market: { ...MARKET, outcome: null },
    events: [snap(1000), tick(1001, 1), tick(1002, 1), tick(1003, 1)],
    strategy, hooks: { on_tick: 'on_tick' }, portfolio: pf,
  });
  assert.equal(pf.sizeOf('0xm', 'UP'), 0, 'the UP leg is closed');
  assert.equal(pf.sizeOf('0xm', 'DOWN'), 100, 'and reversed into DOWN');
  // The close priced against the bid, the reversal against the ask — both from
  // the same book, neither reusing the other's depth.
  const [close, open] = pf.fills.slice(1);
  assert.equal(close.action, 'reduce');
  near(close.avg_px, 0.49);
  assert.equal(open.action, 'open');
  near(open.avg_px, 0.51);
});

test('hold_s flattens the position on the clock', () => {
  const pf = new Portfolio();
  let sent = false;
  const strategy = {
    on_tick() {
      if (sent) return null;
      sent = true;
      return { side: 'UP', size: 100, limit: 1, hold_s: 2 };
    },
  };
  replayMarket({
    market: MARKET,
    events: [snap(1000), tick(1000, 1), tick(2000, 1), tick(4000, 1)],
    strategy, hooks: { on_tick: 'on_tick' }, portfolio: pf,
  });
  assert.equal(pf.trades.length, 1);
  assert.equal(pf.trades[0].how, 'hold_expired');
  assert.equal(pf.sizeOf('0xm', 'UP'), 0);
});

test('a returned null or empty list places nothing', () => {
  const pf = new Portfolio();
  replayMarket({
    market: MARKET, events: [snap(1000), tick(1001, 1)],
    strategy: { on_tick: () => [] }, hooks: { on_tick: 'on_tick' }, portfolio: pf,
  });
  assert.equal(pf.fills.length, 0);
});

// ---------------------------------------------------------------------------
// fill delay — the latency panel
// ---------------------------------------------------------------------------

test('a delayed fill prices against the later book, not the decision book', () => {
  const strategies = () => {
    let sent = false;
    return {
      on_tick() {
        if (sent) return null;
        sent = true;
        return { side: 'UP', size: 100, limit: 1 };
      },
    };
  };
  const events = [
    snap(1000, { asks: [[0.50, 1000]], bids: [[0.49, 1000]] }),
    tick(1000, 1),
    snap(1200, { asks: [[0.80, 1000]], bids: [[0.79, 1000]] }),
    tick(1400, 1),
  ];

  const instant = new Portfolio();
  replayMarket({ market: MARKET, events, strategy: strategies(), hooks: { on_tick: 'on_tick' }, portfolio: instant, fillDelayMs: 0 });
  near(instant.fills[0].avg_px, 0.50);

  const late = new Portfolio();
  replayMarket({ market: MARKET, events, strategy: strategies(), hooks: { on_tick: 'on_tick' }, portfolio: late, fillDelayMs: 250 });
  near(late.fills[0].avg_px, 0.80, 1e-9);
});

test('replaying the same decoded events twice gives the same answer', () => {
  // This is what makes a sweep cost one market-day and a report reproducible.
  const events = [snap(1000), tick(1001, 1), tick(1002, 2), tick(1003, 3)];
  const run = () => {
    const pf = new Portfolio();
    let sent = false;
    replayMarket({
      market: MARKET, events,
      strategy: { on_tick() { if (sent) return null; sent = true; return { side: 'UP', size: 100, limit: 1 }; } },
      hooks: { on_tick: 'on_tick' }, portfolio: pf,
    });
    return pf.trades;
  };
  assert.deepEqual(run(), run());
});

// ---------------------------------------------------------------------------
// ctx
// ---------------------------------------------------------------------------

test('params reach the strategy as ctx.p', () => {
  let seen = null;
  replayMarket({
    market: MARKET, events: [tick(1, 1)],
    strategy: { p: { entry_z: 2.5 }, on_tick(ctx) { seen = ctx.p.entry_z; } },
    hooks: { on_tick: 'on_tick' },
  });
  assert.equal(seen, 2.5);
});

test('ctx.now is the event clock and the only clock', () => {
  const stamps = [];
  replayMarket({
    market: MARKET, events: [tick(1111, 1), tick(2222, 1)],
    strategy: { on_tick(ctx) { stamps.push(ctx.now); } },
    hooks: { on_tick: 'on_tick' },
  });
  assert.deepEqual(stamps, [1111, 2222]);
});

test('reading another market cross-market is refused, not silently answered', () => {
  assert.throws(() => replayMarket({
    market: MARKET, events: [snap(1000), tick(1001, 1)],
    strategy: { on_tick(ctx) { ctx.book('0xOTHER'); } },
    hooks: { on_tick: 'on_tick' },
  }), (err) => {
    assert.equal(err.code, 'E_RUNTIME');
    assert.match(err.detail, /session/);
    return true;
  });
});

test('logs are capped and the truncation is reported', () => {
  const res = replayMarket({
    market: MARKET,
    events: Array.from({ length: 50 }, (_, i) => tick(i + 1, 1)),
    strategy: { on_tick(ctx) { ctx.log('noise'); } },
    hooks: { on_tick: 'on_tick' },
    logLimit: 10,
  });
  assert.equal(res.logs.length, 10);
  assert.equal(res.logTruncated, true);
});

test('an undeclared reference feed is a rejection, not undefined', () => {
  assert.throws(() => replayMarket({
    market: MARKET, events: [tick(1, 1)],
    strategy: { on_tick(ctx) { ctx.ref('binance:btcusdt:spot:1s'); } },
    hooks: { on_tick: 'on_tick' },
  }), /was not declared/);
});

test('zscore over a flat series is zero, not NaN', () => {
  const zs = [];
  replayMarket({
    market: MARKET,
    events: [tick(1, 5), tick(2, 5), tick(3, 5)],
    strategy: { on_tick(ctx, t) { zs.push(ctx.zscore(t.value, { window: 10 })); } },
    hooks: { on_tick: 'on_tick' },
  });
  assert.deepEqual(zs, [0, 0, 0]);
});

test('assert_outcome records a cross-check rather than failing the run', () => {
  const res = replayMarket({
    market: MARKET, events: [tick(1, 1)],
    strategy: { on_settle(ctx, m) { ctx.assert_outcome(m, 'DOWN'); } },
    hooks: { on_settle: 'on_settle' },
  });
  assert.equal(res.crosschecks.length, 1);
  // MARKET settled UP, the strategy claimed DOWN.
  assert.equal(res.crosschecks[0].official, 'UP');
  assert.equal(res.crosschecks[0].match, false);
});

test('a strategy cannot book itself a cross-check match', () => {
  // The panel's whole value is that it is the ARCHIVE's answer. The market
  // argument used to supply both `official` and `market_id`, so a strategy
  // could hand in an object of its own and record a recompute match that never
  // happened — "412 of 412 reconcile" on a report where nothing did.
  const res = replayMarket({
    market: MARKET,                       // really settled UP
    events: [tick(1, 1)],
    strategy: {
      on_settle(ctx, m) {
        m.outcome = 'DOWN';               // mutate what we were handed
        ctx.assert_outcome({ market_id: '0xfake', outcome: 'DOWN' }, 'DOWN');
      },
    },
    hooks: { on_settle: 'on_settle' },
  });
  assert.equal(res.crosschecks.length, 1);
  assert.equal(res.crosschecks[0].market_id, '0xm', 'the engine market, not the claimed one');
  assert.equal(res.crosschecks[0].official, 'UP', 'the archive outcome, not the claimed one');
  assert.equal(res.crosschecks[0].match, false, 'a forged match must not count');
});

// ---------------------------------------------------------------------------
// budget
// ---------------------------------------------------------------------------

test('a single slow event is not a breach', () => {
  const m = new BudgetMonitor({ limitMicros: 400, sampleFloor: 10, tolerance: 0.01 });
  for (let i = 0; i < 100; i += 1) m.record(10);
  m.record(5000);
  assert.equal(m.breached, false, 'one GC pause must not kill a shard');
});

test('sustained breach past the tolerance trips', () => {
  const m = new BudgetMonitor({ limitMicros: 400, sampleFloor: 10, tolerance: 0.01 });
  for (let i = 0; i < 100; i += 1) m.record(5000);
  assert.equal(m.breached, true);
  assert.equal(m.summary().breach_rate, 1);
});

test('a breach below the sample floor never trips', () => {
  // Too few events to say anything about a p99.
  const m = new BudgetMonitor({ limitMicros: 400, sampleFloor: 200 });
  for (let i = 0; i < 5; i += 1) m.record(9999);
  assert.equal(m.breached, false);
});

test('a strategy that throws surfaces as a run abort naming the hook', () => {
  assert.throws(() => replayMarket({
    market: MARKET, events: [tick(1, 1)],
    strategy: { on_tick() { throw new Error('boom'); } },
    hooks: { on_tick: 'on_tick' },
  }), (err) => {
    assert.ok(err instanceof RunAbort);
    assert.match(err.detail, /on_tick threw: boom/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// determinism
// ---------------------------------------------------------------------------

test('the seeded generator is reproducible and seed-separated', () => {
  const rng = makeRng(42);
  const a = rng();
  const b = rng();
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  const other = rng(7);
  assert.notDeepEqual([rng()()], [other()]);
});

test('an unsettled market leaves the position open rather than inventing a price', () => {
  const pf = new Portfolio();
  let sent = false;
  const res = replayMarket({
    market: { ...MARKET, outcome: null },
    events: [snap(1000), tick(1001, 1)],
    strategy: { on_tick() { if (sent) return null; sent = true; return { side: 'UP', size: 100, limit: 1 }; } },
    hooks: { on_tick: 'on_tick' }, portfolio: pf,
  });
  assert.deepEqual(res.settled, []);
  assert.equal(pf.sizeOf('0xm', 'UP'), 100);
});

// ---------------------------------------------------------------------------
// the strategy must not be able to reach the engine
// ---------------------------------------------------------------------------

test('engine internals are not reachable from ctx', () => {
  // This is the whole basis of "the report is computed outside the strategy
  // from engine-owned facts". The previous ctx held _pf/_book/_history as
  // ordinary properties, and a strategy could push a fabricated settled trade
  // straight into the report — a $990,000 profit that never happened.
  const seen = {};
  replayMarket({
    market: MARKET,
    events: [snap(1000), tick(1001, 1)],
    strategy: {
      on_tick(ctx) {
        for (const name of ['_pf', '_book', '_history', '_logs', '_crosschecks', '_refs', '_rng']) {
          seen[name] = ctx[name];
        }
        return null;
      },
    },
    hooks: { on_tick: 'on_tick' },
  });
  for (const [name, value] of Object.entries(seen)) {
    assert.equal(value, undefined, `ctx.${name} must not be reachable`);
  }
});

test('a strategy cannot fabricate trades into the report', () => {
  const pf = new Portfolio();
  replayMarket({
    market: { ...MARKET, outcome: null },
    events: [snap(1000), tick(1001, 1)],
    strategy: {
      on_tick(ctx) {
        // Every route the old shape allowed.
        try { ctx._pf.trades.push({ pnl: 1e9 }); } catch { /* expected */ }
        try { ctx.position().size = 1e9; } catch { /* a copy at worst */ }
        return null;
      },
    },
    hooks: { on_tick: 'on_tick' },
    portfolio: pf,
  });
  assert.equal(pf.trades.length, 0, 'no trade may exist that the engine did not make');
});

test('the tick history handed out is a copy', () => {
  // Mutating it would let a strategy rewrite the series its own zscore is
  // computed from — and the report's per-trade prices with it.
  const zs = [];
  replayMarket({
    market: MARKET,
    events: [tick(1, 10), tick(2, 20), tick(3, 30)],
    strategy: {
      on_tick(ctx, t) {
        const h = ctx.history(10);
        if (h.length) h[0].value = 999_999;
        zs.push(ctx.zscore(t.value, { window: 10 }));
        return null;
      },
    },
    hooks: { on_tick: 'on_tick' },
  });
  // If the mutation had landed, the third z-score would be wild.
  assert.ok(Math.abs(zs[2]) < 5, `history mutation leaked into zscore: ${zs[2]}`);
});

// ---------------------------------------------------------------------------
// nothing happens after the close
// ---------------------------------------------------------------------------

test('a delayed order that misses the close never fills', () => {
  // drainUntil(Infinity) used to run it at its own future timestamp, producing
  // a trade opened AFTER it closed and pricing a fill against a book that no
  // longer existed.
  const pf = new Portfolio();
  let sent = false;
  replayMarket({
    market: { ...MARKET, close_ts_ms: 1005 },
    events: [snap(1000), tick(1000, 1)],
    strategy: {
      on_tick() { if (sent) return null; sent = true; return { side: 'UP', size: 100, limit: 1 }; },
    },
    hooks: { on_tick: 'on_tick' },
    portfolio: pf,
    fillDelayMs: 500,   // lands at 1500, well past the 1005 close
  });
  assert.equal(pf.fills.length, 0, 'an order that had not landed by the close did not land');
  assert.equal(pf.trades.length, 0);
});

test('no trade can close before it opened', () => {
  const pf = new Portfolio();
  let sent = false;
  replayMarket({
    market: { ...MARKET, close_ts_ms: 1200, outcome: 'UP' },
    events: [snap(1000), tick(1000, 1), tick(1100, 1)],
    strategy: {
      on_tick() { if (sent) return null; sent = true; return { side: 'UP', size: 100, limit: 1 }; },
    },
    hooks: { on_tick: 'on_tick' },
    portfolio: pf,
    fillDelayMs: 50,
  });
  for (const t of pf.trades) {
    assert.ok(t.opened_ms <= t.closed_ms, `impossible row: opened ${t.opened_ms}, closed ${t.closed_ms}`);
  }
});

test('the book handed to a strategy cannot be edited', () => {
  // Verified before the fix: a strategy unshifted a level that never existed
  // and filled at $0.01 in a market whose real best ask was $0.90 — and the
  // fabricated fill went into the report as fact.
  const pf = new Portfolio();
  let sent = false;
  replayMarket({
    market: { ...MARKET, close_ts_ms: 9000 },
    events: [
      snap(1000, { asks: [[0.90, 10]], bids: [] }, { asks: [], bids: [] }),
      tick(1001, 1),
    ],
    strategy: {
      on_tick(ctx) {
        if (sent) return null;
        sent = true;
        const b = ctx.book();
        // Every handle the live object used to offer.
        try { b.ladders.UP.asks.levels.unshift({ ticks: 100, size: 100000 }); } catch { /* expected */ }
        try { b.snapshot(1, { UP: { asks: [[0.01, 1e6]], bids: [] } }); } catch { /* expected */ }
        try { b.ladders = null; } catch { /* expected */ }
        const rows = b.levels('UP', 5);
        if (rows.length) rows[0][0] = 0.01;
        return { side: 'UP', size: 1000, limit: 1 };
      },
    },
    hooks: { on_tick: 'on_tick' },
    portfolio: pf,
  });
  assert.equal(pf.fills.length, 1);
  // Only the 10 contracts that genuinely rested, at the price they rested at.
  near(pf.fills[0].avg_px, 0.90);
  assert.equal(pf.fills[0].filled, 10);
  assert.equal(pf.fills[0].unfilled, 990);
});

test('writing to the tick it is handed does not rewrite history', () => {
  // ctx.history() returns copies, but the row STORED in history used to be the
  // same object the hook was given — so `tick.value = x` rewrote the series
  // zscore, sma and ema are computed from.
  const readings = [];
  replayMarket({
    market: { ...MARKET, outcome: null },
    events: [tick(1, 10), tick(2, 20), tick(3, 30)],
    strategy: {
      on_tick(ctx, t) {
        readings.push(ctx.history(10).map((h) => h.value));
        t.value = 999_999;
        return null;
      },
    },
    hooks: { on_tick: 'on_tick' },
  });
  assert.deepEqual(readings, [[10], [10, 20], [10, 20, 30]],
    'the stored series must be the real one');
});

// ---------------------------------------------------------------------------
// look-ahead — the one claim this product cannot lose
// ---------------------------------------------------------------------------

test('the settled outcome is not visible before settlement', () => {
  // The worker's market metadata carries the settled result, and replayMarket
  // used to hand the whole object to on_market_open. A strategy read
  // market.outcome on the first hook, bought the winning side at $0.10, and
  // made 900 — with every number in the report following it. This is not an
  // output-forgery hole; it was the documented SDK input handing over the
  // answer.
  const seen = {};
  replayMarket({
    market: { ...MARKET, outcome: 'UP' },
    events: [snap(1000), tick(1001, 1), { kind: 'trade', ts_ms: 1002 }],
    strategy: {
      on_market_open(ctx, m) { seen.open = 'outcome' in m; seen.strike = m.strike; },
      on_tick(ctx, t) { seen.tick = t.outcome; return null; },
      on_settle(ctx, m, outcome) { seen.settle = m.outcome; seen.arg = outcome; },
    },
    hooks: { on_market_open: 'on_market_open', on_tick: 'on_tick', on_settle: 'on_settle' },
  });
  assert.equal(seen.open, false, 'on_market_open must not carry the outcome');
  // The strike IS known when the market opens, and the docs say so.
  assert.equal(seen.strike, 65000);
  assert.equal(seen.settle, 'UP', 'on_settle carries it — that is its whole job');
  assert.equal(seen.arg, 'UP');
});

test('settlement still uses the archive outcome after the view is stripped', () => {
  const pf = new Portfolio();
  let sent = false;
  replayMarket({
    market: { ...MARKET, outcome: 'UP' },
    events: [snap(1000), tick(1001, 1)],
    strategy: {
      on_market_open() {},
      on_tick() { if (sent) return null; sent = true; return { side: 'UP', size: 100, limit: 1 }; },
    },
    hooks: { on_market_open: 'on_market_open', on_tick: 'on_tick' },
    portfolio: pf,
  });
  assert.equal(pf.trades[0].how, 'settled');
  assert.equal(pf.trades[0].outcome, 'UP');
  near(pf.trades[0].pnl, 50);
});

test('nothing after the close reaches a hook, the book, or the history', () => {
  // The settlement feed is a per-DAY stream and fetch-data hands every row to
  // every market that settles on it — so a market closing at 10:00 was still
  // shown 14:00's ticks. A strategy could watch the price that decides its own
  // settlement, hours after its market closed, and write it into the archived
  // log. The pending-order cutoff fixed the ORDERS; this is the EVENTS.
  const seen = [];
  const bookPrices = [];
  const res = replayMarket({
    market: { ...MARKET, close_ts_ms: 1000 },
    events: [
      snap(900, { asks: [[0.50, 100]], bids: [[0.49, 100]] }),
      tick(900, 100),
      tick(1000, 100),
      // Everything below is after the close and must be invisible.
      snap(1500, { asks: [[0.99, 100]], bids: [[0.98, 100]] }),
      tick(1500, 101),
      tick(5000, 999),
    ],
    strategy: {
      on_tick(ctx, t) {
        seen.push(t.ts_ms);
        bookPrices.push(ctx.book().best('UP'));
        ctx.log(`saw=${t.ts_ms}`);
        return null;
      },
    },
    hooks: { on_tick: 'on_tick' },
  });
  assert.deepEqual(seen, [900, 1000], 'the close itself is included; nothing past it is');
  assert.deepEqual(bookPrices, [0.50, 0.50], 'the post-close book must never be applied');
  // `events` now counts what the engine PULLED, not what was supplied: with a
  // stream there is no way to know the latter without draining it, and pulling
  // more than it needs is exactly what this change stops.
  assert.equal(res.events, 4, 'stopped one past the close, having pulled no further');
  for (const line of res.logs) {
    assert.ok(!/saw=(1500|5000)/.test(line), `a post-close tick reached the log: ${line}`);
  }
});

test('an unsupported time-in-force is refused, not silently downgraded', () => {
  // gtc was advertised in the SDK reference and executed as a single IOC
  // attempt: if the book did not fill at that instant the order vanished,
  // though the documented semantics say it rests until the close. That is a
  // wrong fill, slippage and PnL number for an order type we told customers we
  // supported. Refused instead — the same call the docs already make about
  // resting orders.
  assert.throws(() => replayMarket({
    market: MARKET,
    events: [snap(1000), tick(1001, 1)],
    strategy: { on_tick() { return { side: 'UP', size: 100, limit: 1, tif: 'gtc' }; } },
    hooks: { on_tick: 'on_tick' },
  }), (err) => {
    // E_MANIFEST, not E_RUNTIME: it is a contract violation, and it is raised
    // from the order path rather than from inside the hook.
    assert.equal(err.code, 'E_MANIFEST');
    assert.match(err.detail, /tif "gtc" is not supported/);
    return true;
  });

  // The default and the explicit ioc both still work.
  assert.doesNotThrow(() => replayMarket({
    market: MARKET,
    events: [snap(1000), tick(1001, 1)],
    strategy: { on_tick() { return { side: 'UP', size: 100, limit: 1, tif: 'ioc' }; } },
    hooks: { on_tick: 'on_tick' },
  }));
});
