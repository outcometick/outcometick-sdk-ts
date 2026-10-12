import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayMarket, makeLogBudget, BudgetMonitor, RunAbort, makeRng, MarketReplay } from './replay.mjs';
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
    // Do not dispatch the undeclared on_trade hook.
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
  // History grows only as events are replayed.
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
  // Leave the outcome null to inspect positions before settlement.
  replayMarket({
    market: { ...MARKET, outcome: null },
    events: [snap(1000), tick(1001, 1), tick(1002, 1), tick(1003, 1)],
    strategy, hooks: { on_tick: 'on_tick' }, portfolio: pf,
  });
  assert.equal(pf.sizeOf('0xm', 'UP'), 0, 'the UP leg is closed');
  assert.equal(pf.sizeOf('0xm', 'DOWN'), 100, 'and reversed into DOWN');
  // The close uses bids and the reversal uses asks from the same book.
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
// fill delay
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
  // Reusing decoded data must produce deterministic replay results.
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
    // The engine's own refusal, with its own code -- not a strategy error.
    assert.equal(err.code, 'E_STATE');
    assert.match(err.detail, /session/);
    return true;
  });
});

test('logs are capped by BYTES and the truncation is reported', () => {
  const budget = makeLogBudget({ bytes: 100, lineChars: 512 });
  const res = replayMarket({
    market: MARKET,
    events: Array.from({ length: 50 }, (_, i) => tick(i + 1, 1)),
    strategy: { on_tick(ctx) { ctx.log('noise'); } },
    hooks: { on_tick: 'on_tick' },
    logBudget: budget,
  });
  assert.ok(res.logs.length > 0 && res.logs.length < 50, 'the cap did nothing');
  assert.ok(budget.spent >= 100, 'the budget was not spent');
  assert.equal(res.logTruncated, true);
});

// Enforce the per-line limit independently of the run-wide log budget.
test('a single line cannot exceed the line cap', () => {
  const budget = makeLogBudget({ bytes: 1_000_000, lineChars: 32 });
  const res = replayMarket({
    market: MARKET,
    events: [tick(1, 1)],
    strategy: { on_tick(ctx) { ctx.log('x'.repeat(5000)); } },
    hooks: { on_tick: 'on_tick' },
    logBudget: budget,
  });
  assert.equal(res.logs.length, 1);
  assert.ok(res.logs[0].length <= 32, `a ${res.logs[0].length}-character line got through a 32-character cap`);
});

// Count logs in UTF-8 bytes, matching logs.txt. UTF-16 string length
// undercounts multi-byte text.
test('the log budget counts UTF-8 bytes, not string length', () => {
  const line = '数据数据数据数据数据';        // 10 chars, 30 UTF-8 bytes
  const budget = makeLogBudget({ bytes: 1_000_000, lineChars: 512 });
  replayMarket({
    market: MARKET,
    events: [tick(1, 1)],
    strategy: { on_tick(ctx) { ctx.log(line); } },
    hooks: { on_tick: 'on_tick' },
    logBudget: budget,
  });
  // The timestamp prefix is ASCII, so the multi-byte part is what separates
  // the two units: counting characters would undercount it by 20.
  const written = Buffer.byteLength(`0 ${line}`, 'utf8') + 1;
  assert.equal(budget.spent, written,
    `spent ${budget.spent} for a line that occupies ${written} bytes in logs.txt`);
});

// Bound crosschecks on the authenticated result channel independently of logs.
test('cross-checks are bounded in count and in payload size', () => {
  const res = replayMarket({
    market: MARKET,
    events: Array.from({ length: 200 }, (_, i) => tick(i + 1, 1)),
    strategy: {
      on_tick(ctx) { ctx.assert_outcome(null, 'U'.repeat(10_000)); },
    },
    hooks: { on_tick: 'on_tick' },
  });
  assert.ok(res.crosschecks.length > 0, 'nothing was recorded at all');
  assert.ok(res.crosschecks.length <= 16,
    `${res.crosschecks.length} cross-checks from 200 events — the count is unbounded`);
  for (const c of res.crosschecks) {
    assert.ok(c.claimed.length <= 32,
      `a ${c.claimed.length}-character claim got onto the result line`);
  }
  // Truncating recorded details must not change the crosscheck verdict.
  assert.equal(res.crosschecks[0].match, false);
});

// Share one log budget across all markets in a run.
test('the log allowance is spent across markets, not renewed per market', () => {
  const budget = makeLogBudget({ bytes: 300, lineChars: 512 });
  const run = () => replayMarket({
    market: MARKET,
    events: Array.from({ length: 20 }, (_, i) => tick(i + 1, 1)),
    strategy: { on_tick(ctx) { ctx.log('some line of output'); } },
    hooks: { on_tick: 'on_tick' },
    logBudget: budget,
  });

  const first = run();
  assert.ok(first.logs.length > 0, 'the first market logged nothing at all');
  const spentAfterFirst = budget.spent;

  // The second market uses the remaining run budget.
  const second = run();
  assert.ok(budget.spent >= spentAfterFirst, 'the budget went backwards');
  assert.ok(budget.spent <= 300 + 512, 'the second market was given a fresh allowance');
  assert.ok(second.logs.length < first.logs.length,
    'the second market logged as much as the first — the allowance is being renewed per market');
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
  // The market settled UP; the strategy claimed DOWN.
  assert.equal(res.crosschecks[0].official, 'UP');
  assert.equal(res.crosschecks[0].match, false);
});

test('a strategy cannot book itself a cross-check match', () => {
  // Derive official outcome and market id from engine-owned metadata.
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
  // At the 2,000-event window, one event needs 800 ms to exceed a 400 us
  // mean budget. The measured hosted-runner spike was 18 ms (W > 45).
  const m = new BudgetMonitor({ limitMicros: 400 });
  for (let i = 0; i < 4000; i += 1) m.record(10);
  m.record(18_000);
  assert.equal(m.breached, false, 'one GC pause must not kill a shard');

  // A tiny window makes the same spike dominate its mean.
  const narrow = new BudgetMonitor({ limitMicros: 400, sampleFloor: 10 });
  for (let i = 0; i < 100; i += 1) narrow.record(10);
  narrow.record(18_000);
  assert.equal(narrow.breached, true, 'a ten-event window cannot absorb anything');
});

test('sustained cost over the limit trips', () => {
  const m = new BudgetMonitor({ limitMicros: 400, sampleFloor: 10 });
  for (let i = 0; i < 100; i += 1) m.record(5000);
  assert.equal(m.breached, true);
  assert.equal(m.summary().breach_rate, 1);
});

test('a breach below the sample floor never trips', () => {
  // Too few events to say anything about a mean.
  const m = new BudgetMonitor({ limitMicros: 400, sampleFloor: 200 });
  for (let i = 0; i < 5; i += 1) m.record(9999);
  assert.equal(m.breached, false);
});

// Use mean hook time, since scheduling interruptions inflate slow-event counts.
test('a fast strategy on a contended machine is not rejected', () => {
  // Hosted-runner sample: 72 us mean with 1.1% interrupted events,
  // below the 400 us mean budget.
  const m = new BudgetMonitor({ limitMicros: 400 });
  let killedAt = null;
  for (let i = 0; i < 10_000; i += 1) {
    m.record(i % 91 === 0 ? 5800 : 8);
    if (m.breached && killedAt == null) killedAt = m.summary().events;
  }
  const s = m.summary();
  assert.ok(s.breach_rate > 0.01, `setup wrong: breach rate ${s.breach_rate} does not trip the old 1% rule`);
  assert.ok(s.avg_micros < 400, `setup wrong: mean ${s.avg_micros} is not inside budget`);
  assert.equal(killedAt, null,
    `a strategy averaging ${s.avg_micros.toFixed(0)}us of its 400us budget was killed at event ${killedAt}`);
});

test('a strategy that is genuinely slow is still rejected', () => {
  // Consistently expensive hooks must exceed the mean budget.
  const m = new BudgetMonitor({ limitMicros: 400 });
  let killedAt = null;
  for (let i = 0; i < 10_000; i += 1) {
    m.record(600);
    if (m.breached && killedAt == null) killedAt = m.summary().events;
  }
  assert.equal(killedAt, 2000, 'a uniformly slow strategy must be caught at the sample floor');
});

// A rolling mean prevents a cheap prefix from masking an expensive phase.
test('a cheap prefix cannot pay for a sustained slow phase', () => {
  const m = new BudgetMonitor({ limitMicros: 400 });
  let killedAt = null;
  for (let i = 0; i < 18_000; i += 1) {
    m.record(8);
    if (m.breached && killedAt == null) killedAt = m.summary().events;
  }
  assert.equal(killedAt, null, 'the cheap prefix must not be rejected');
  for (let i = 0; i < 2_000; i += 1) {
    m.record(2_000);
    if (m.breached && killedAt == null) killedAt = m.summary().events;
  }
  const s = m.summary();
  assert.ok(s.avg_micros < 400,
    `setup wrong: the lifetime mean is ${s.avg_micros.toFixed(0)}us, so this passes for the wrong reason`);
  assert.ok(killedAt != null && killedAt < 20_000,
    'two thousand consecutive events at 5x budget were hidden by the lifetime average');
});

test('a rare but catastrophic event still raises the mean', () => {
  // A 1% tail of one-second events contributes 10 ms to the mean.
  const m = new BudgetMonitor({ limitMicros: 400 });
  for (let i = 0; i < 10_000; i += 1) m.record(i % 100 === 0 ? 1_000_000 : 10);
  assert.equal(m.breached, true, 'a 1% tail of one-second events must not pass');
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
  // Contexts must not expose mutable portfolio, book or history internals.
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
        // Check each possible internal-state handle.
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
  // History mutations must not change indicators or reported prices.
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
  // Pending orders after the close must not execute.
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
  // Book views must not allow a strategy to insert fabricated liquidity.
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
        // Check each book-state handle.
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
  // Store a separate history row so hook mutations cannot rewrite indicators.
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
// look-ahead
// ---------------------------------------------------------------------------

test('the settled outcome is not visible before settlement', () => {
  // Opening metadata must omit the terminal outcome.
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
  // The strike is available at market open.
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
  // Day-wide settlement feeds must stop delivering events at the market close.
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
  // Count events pulled from the iterator without draining future rows.
  assert.equal(res.events, 4, 'stopped one past the close, having pulled no further');
  for (const line of res.logs) {
    assert.ok(!/saw=(1500|5000)/.test(line), `a post-close tick reached the log: ${line}`);
  }
});

test('an unsupported time-in-force is refused, not silently downgraded', () => {
  // Reject unsupported TIF values; ioc, gtc and declared fok are supported.
  assert.throws(() => replayMarket({
    market: MARKET,
    events: [snap(1000), tick(1001, 1)],
    strategy: { on_tick() { return { side: 'UP', size: 100, limit: 1, tif: 'day' }; } },
    hooks: { on_tick: 'on_tick' },
  }), (err) => {
    // E_MANIFEST, not E_RUNTIME: it is a contract violation, and it is raised
    // from the order path rather than from inside the hook.
    assert.equal(err.code, 'E_MANIFEST');
    assert.match(err.detail, /tif "day" is not supported/);
    return true;
  });
  // fok exists, but only for a run that declared it ("fok": true): its fill
  // rows carry a column the writer must know about before the first row.
  assert.throws(() => replayMarket({
    market: MARKET,
    events: [snap(1000), tick(1001, 1)],
    strategy: { on_tick() { return { side: 'UP', size: 100, limit: 1, tif: 'fok' }; } },
    hooks: { on_tick: 'on_tick' },
  }), (err) => err.code === 'E_MANIFEST' && /needs "fok": true/.test(err.detail));

  // gtc without a resting-order policy (no trades declared, or Predict) is
  // refused with the policy's reason, without an IOC fallback.
  assert.throws(() => replayMarket({
    market: MARKET,
    events: [snap(1000), tick(1001, 1)],
    strategy: { on_tick() { return { side: 'UP', size: 100, limit: 0.4, tif: 'gtc' }; } },
    hooks: { on_tick: 'on_tick' },
  }), (err) => err.code === 'E_MANIFEST' && /resting/.test(err.detail));

  // The default and the explicit ioc both still work.
  assert.doesNotThrow(() => replayMarket({
    market: MARKET,
    events: [snap(1000), tick(1001, 1)],
    strategy: { on_tick() { return { side: 'UP', size: 100, limit: 1, tif: 'ioc' }; } },
    hooks: { on_tick: 'on_tick' },
  }));
});

test('the budget floor outlasts a strategy warming up', async () => {
  // Require enough events before judging the mean, including during warm-up.
  const { BudgetMonitor } = await import('./replay.mjs');
  // Check the verdict after each event, as replay does.
  const m = new BudgetMonitor({ limitMicros: 400 });
  let killedAt = null;
  for (let i = 0; i < 3; i += 1) {
    m.record(2500);                                       // the warm-up
    if (m.breached && killedAt == null) killedAt = m.summary().events;
  }
  for (let i = 0; i < 4500; i += 1) {
    m.record(25);                                         // the actual strategy
    if (m.breached && killedAt == null) killedAt = m.summary().events;
  }
  assert.equal(killedAt, null,
    `three slow first calls killed the run at event ${killedAt}`);

  // The floor still holds: a short market cannot be judged on a handful of
  // events, however slow they were.
  const tiny = new BudgetMonitor({ limitMicros: 400 });
  for (let i = 0; i < 50; i += 1) tiny.record(9000);
  assert.equal(tiny.breached, false, 'fifty events is not a verdict');
});

// Top-of-book bounds refine depth without dispatching on_book.
// Check this independently of cross-engine agreement.
test('a bound refines the book but never reaches a hook', () => {
  const seen = [];
  const strategy = {
    on_market_open() {},
    on_book(ctx, e) { seen.push(e); },
    on_tick(ctx, t) { seen.push(['tick', t.ts_ms, ctx.book().best('UP')]); },
  };
  replayMarket({
    market: MARKET,
    events: [
      // A real snapshot: this one SHOULD wake on_book.
      snap(1000, { asks: [[0.44, 10], [0.45, 20]], bids: [[0.40, 10]] },
        { asks: [[0.56, 10]], bids: [[0.55, 10]] }),
      // A bound: prunes 0.44 and must stay silent.
      { kind: 'book', ts_ms: 2000, snapshot: false, bbo: true, side: 'UP', bid: 0.40, ask: 0.45 },
      tick(2001, 65000),
    ],
    strategy,
    hooks: { on_market_open: 'on_market_open', on_book: 'on_book', on_tick: 'on_tick' },
  });

  const books = seen.filter((s) => !Array.isArray(s));
  assert.equal(books.length, 1, 'exactly the real snapshot should have woken on_book');
  assert.ok(books[0].levels, 'the event handed to on_book must be a real book event');
  // The next ordinary hook sees the pruned book through ctx.book().
  const t = seen.find((s) => Array.isArray(s));
  assert.deepEqual(t, ['tick', 2001, 0.45], 'the pruned ladder is what the next hook reads');
});

test('global scheduler: a cancel through a kept ctx is asked at the run clock and pays the full latency', () => {
  const T = 1_000_000;
  const market = { market_id: 'm', open_ts_ms: T, close_ts_ms: T + 60_000, outcome: 'UP' };
  const clock = { t: -Infinity };
  const strategy = {
    on_market_open(ctx) { this.ctx = ctx; },
    on_book() { return this.sent ? null : ((this.sent = true), { side: 'UP', size: 5, limit: 0.4, tif: 'gtc', client_id: 'x' }); },
  };
  const r = new MarketReplay({
    market, strategy, hooks: { on_market_open: 'on_market_open', on_book: 'on_book' },
    resting: { allowed: true, refusal: null, cancelLatencyMs: 10 },
    engine: { scheduler: 'global', timers: false, feed_latency: 0 }, clock,
  });
  r.open(T);
  r.step({ kind: 'book', ts_ms: T, snapshot: true, levels: { UP: { asks: [[0.6, 10]], bids: [[0.39, 10]] }, DOWN: { asks: [[0.61, 10]], bids: [[0.4, 10]] } } });
  clock.t = T;
  r.runOne(); // the activation, at T
  assert.equal(r.maker.stats.rested, 1);
  // Another market has taken the run to T + 5000; this market's now is still T.
  clock.t = T + 5000;
  assert.equal(strategy.ctx.now, T);
  assert.equal(strategy.ctx.cancel('x'), true);
  assert.equal(r.nextDue().at, T + 5010, 'asked at the run clock, plus the full cancel latency');
});
