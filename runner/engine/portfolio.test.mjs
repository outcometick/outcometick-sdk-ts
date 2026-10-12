import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Book } from './book.mjs';
import { Portfolio, contractValue, newBookAge } from './portfolio.mjs';
import { bookAgeReport } from './report.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

function mkBook({ asks = [[0.50, 1000]], bids = [[0.49, 1000]], down } = {}) {
  const b = new Book('0xm');
  b.snapshot(1000, {
    UP: { asks, bids },
    DOWN: down ?? { asks: [[0.51, 1000]], bids: [[0.50, 1000]] },
  });
  return b;
}

// ---------------------------------------------------------------------------
// opening
// ---------------------------------------------------------------------------

test('buying posts collateral in full', () => {
  const p = new Portfolio();
  const b = mkBook();
  p.execute({ book: b, ts: 1, marketId: '0xm', order: { side: 'UP', size: 500, limit: 0.55 } });
  // 500 contracts at $0.50 = $250 out of pocket.
  near(p.cash, -250);
  assert.equal(p.sizeOf('0xm', 'UP'), 500);
  const pos = p.position('0xm', b);
  assert.equal(pos.side, 'UP');
  assert.equal(pos.size, 500);
  near(pos.avg_entry, 0.50);
});

test('a partial fill only takes a position in what filled', () => {
  const p = new Portfolio();
  const b = mkBook({ asks: [[0.50, 100]] });
  const res = p.execute({ book: b, ts: 1, marketId: '0xm', order: { side: 'UP', size: 500, limit: 0.55 } });
  assert.equal(res.filled, 100);
  assert.equal(res.unfilled, 400);
  assert.equal(p.sizeOf('0xm', 'UP'), 100);
  near(p.cash, -50);
});

test('an unfillable order still records a fill row so slippage can see it', () => {
  const p = new Portfolio();
  const b = mkBook();
  p.execute({ book: b, ts: 1, marketId: '0xm', order: { side: 'UP', size: 500, limit: 0.40 } });
  assert.equal(p.fills.length, 1);
  assert.equal(p.fills[0].filled, 0);
  assert.equal(p.fills[0].unfilled, 500);
  assert.equal(p.fills[0].quoted_px, 0.50);
  assert.equal(p.trades.length, 0);
});

test('topping up blends the average entry', () => {
  const p = new Portfolio();
  const b = mkBook({ asks: [[0.50, 100], [0.60, 100]] });
  p.execute({ book: b, ts: 1, marketId: '0xm', order: { side: 'UP', size: 100, limit: 0.55 } });
  p.execute({ book: b, ts: 2, marketId: '0xm', order: { side: 'UP', size: 100, limit: 0.65 } });
  near(p.position('0xm').avg_entry, 0.55);
  assert.equal(p.sizeOf('0xm', 'UP'), 200);
});

// ---------------------------------------------------------------------------
// position reporting
// ---------------------------------------------------------------------------

test('a flat position reports null side and zero size', () => {
  const p = new Portfolio();
  const pos = p.position('0xm');
  assert.deepEqual(
    { side: pos.side, size: pos.size, avg_entry: pos.avg_entry },
    { side: null, size: 0, avg_entry: null },
  );
});

test('unrealised is marked to the bid, not the ask', () => {
  // Marking at the ask would report a profit the position cannot be closed at.
  const p = new Portfolio();
  const b = mkBook({ asks: [[0.50, 1000]], bids: [[0.49, 1000]] });
  p.execute({ book: b, ts: 1, marketId: '0xm', order: { side: 'UP', size: 100, limit: 0.55 } });
  const pos = p.position('0xm', b);
  near(pos.unrealised, (0.49 - 0.50) * 100);
});

test('a hedged position reports the larger leg and flags it', () => {
  const p = new Portfolio();
  const b = mkBook();
  p.execute({ book: b, ts: 1, marketId: '0xm', order: { side: 'UP', size: 100, limit: 1 } });
  p.execute({ book: b, ts: 1, marketId: '0xm', order: { side: 'DOWN', size: 300, limit: 1 } });
  const pos = p.position('0xm', b);
  assert.equal(pos.side, 'DOWN');
  assert.equal(pos.size, 300);
  assert.equal(pos.both, true);
});

// ---------------------------------------------------------------------------
// reducing
// ---------------------------------------------------------------------------

test('reduce_only sells into the bid and books the realised PnL', () => {
  const p = new Portfolio();
  const b = mkBook({ asks: [[0.50, 1000]], bids: [[0.60, 1000]] });
  p.execute({ book: b, ts: 1, marketId: '0xm', order: { side: 'UP', size: 100, limit: 0.55 } });
  p.execute({ book: b, ts: 2, marketId: '0xm', order: { side: 'UP', size: 100, limit: null, reduce_only: true } });

  assert.equal(p.sizeOf('0xm', 'UP'), 0);
  near(p.cash, 10);            // paid 50, sold for 60
  assert.equal(p.trades.length, 1);
  const t = p.trades[0];
  near(t.entry_px, 0.50);
  near(t.exit_px, 0.60);
  near(t.pnl, 10);
  assert.equal(t.how, 'exit');
  assert.equal(t.size, 100);
});

test('reduce_only is clamped to the open size and never flips the position', () => {
  const p = new Portfolio();
  const b = mkBook({ asks: [[0.50, 1000]], bids: [[0.49, 1000]] });
  p.execute({ book: b, ts: 1, marketId: '0xm', order: { side: 'UP', size: 100, limit: 1 } });
  p.execute({ book: b, ts: 2, marketId: '0xm', order: { side: 'UP', size: 999, limit: null, reduce_only: true } });
  assert.equal(p.sizeOf('0xm', 'UP'), 0);
  assert.equal(p.fills[1].filled, 100, 'only the open size may be closed');
});

test('reduce_only with nothing open is rejected, not turned into a short', () => {
  const p = new Portfolio();
  const b = mkBook();
  const res = p.execute({ book: b, ts: 1, marketId: '0xm', order: { side: 'UP', size: 100, reduce_only: true } });
  assert.equal(res, null);
  assert.equal(p.rejected, 1);
  assert.equal(p.sizeOf('0xm', 'UP'), 0);
});

test('a partial close leaves the trade open and blends the exit when it finishes', () => {
  const p = new Portfolio();
  const b = mkBook({ asks: [[0.50, 1000]], bids: [[0.60, 50], [0.40, 1000]] });
  p.execute({ book: b, ts: 1, marketId: '0xm', order: { side: 'UP', size: 100, limit: 1 } });
  p.execute({ book: b, ts: 2, marketId: '0xm', order: { side: 'UP', size: 50, limit: null, reduce_only: true } });
  assert.equal(p.trades.length, 0, 'still holding half');
  assert.equal(p.sizeOf('0xm', 'UP'), 50);

  p.execute({ book: b, ts: 3, marketId: '0xm', order: { side: 'UP', size: 50, limit: null, reduce_only: true } });
  assert.equal(p.trades.length, 1);
  const t = p.trades[0];
  assert.equal(t.size, 100);
  near(t.exit_px, (50 * 0.60 + 50 * 0.40) / 100);
  near(t.pnl, 50 * 0.10 + 50 * -0.10);
});

// ---------------------------------------------------------------------------
// settlement
// ---------------------------------------------------------------------------

test('a winning side settles at one dollar a contract', () => {
  assert.equal(contractValue('UP', 'UP'), 1);
  assert.equal(contractValue('UP', 'DOWN'), 0);

  const p = new Portfolio();
  const b = mkBook();
  p.execute({ book: b, ts: 1, marketId: '0xm', order: { side: 'UP', size: 500, limit: 0.55 } });
  const closed = p.settle('0xm', 'UP', 9999);
  assert.equal(closed.length, 1);
  near(closed[0].pnl, 500 * (1 - 0.50));
  near(closed[0].exit_px, 1);
  assert.equal(closed[0].how, 'settled');
  near(p.cash, 250);
  assert.equal(p.sizeOf('0xm', 'UP'), 0);
});

test('a losing side settles at zero and loses the whole stake', () => {
  const p = new Portfolio();
  const b = mkBook();
  p.execute({ book: b, ts: 1, marketId: '0xm', order: { side: 'UP', size: 500, limit: 0.55 } });
  const [t] = p.settle('0xm', 'DOWN', 9999);
  near(t.pnl, -250);
  near(t.exit_px, 0);
  near(p.cash, -250);
});

test('a tie settles 50:50 — both sides at half a dollar a contract', () => {
  assert.equal(contractValue('UP', 'TIE'), 0.5);
  assert.equal(contractValue('DOWN', 'TIE'), 0.5);

  const p = new Portfolio();
  const b = mkBook();
  p.execute({ book: b, ts: 1, marketId: '0xm', order: { side: 'UP', size: 500, limit: 0.55 } });
  const [t] = p.settle('0xm', 'TIE', 9999);
  near(t.pnl, 500 * (0.5 - 0.50));
  near(t.exit_px, 0.5);
  assert.equal(t.outcome, 'TIE');
  assert.equal(t.how, 'settled');
  near(p.cash, 0);

  // Both legs of a hedge pay out: 100 pairs bought at 0.50 + 0.51, received 1.00.
  const h = new Portfolio();
  h.execute({ book: b, ts: 1, marketId: '0xm', order: { side: 'UP', size: 100, limit: 1 } });
  h.execute({ book: b, ts: 1, marketId: '0xm', order: { side: 'DOWN', size: 100, limit: 1 } });
  assert.equal(h.settle('0xm', 'TIE', 9999).length, 2);
  near(h.cash, 100 * (1 - 0.50 - 0.51));
});

test('settling with nothing open produces no trade row', () => {
  const p = new Portfolio();
  assert.deepEqual(p.settle('0xm', 'UP', 1), []);
  assert.equal(p.trades.length, 0);
});

test('a hedged market settles both legs', () => {
  const p = new Portfolio();
  const b = mkBook();
  p.execute({ book: b, ts: 1, marketId: '0xm', order: { side: 'UP', size: 100, limit: 1 } });
  p.execute({ book: b, ts: 1, marketId: '0xm', order: { side: 'DOWN', size: 100, limit: 1 } });
  const closed = p.settle('0xm', 'UP', 9999);
  assert.equal(closed.length, 2);
  // Paid 0.50 + 0.51 = 1.01 per pair, received 1.00. The hedge loses the spread.
  near(p.cash, 100 * (1 - 0.50 - 0.51));
});

// ---------------------------------------------------------------------------
// flatten
// ---------------------------------------------------------------------------

test('flatten closes against the bid', () => {
  const p = new Portfolio();
  const b = mkBook({ asks: [[0.50, 1000]], bids: [[0.55, 1000]] });
  p.execute({ book: b, ts: 1, marketId: '0xm', order: { side: 'UP', size: 100, limit: 1 } });
  p.flatten('0xm', b, 2);
  assert.equal(p.sizeOf('0xm', 'UP'), 0);
  assert.equal(p.trades[0].how, 'hold_expired');
  near(p.trades[0].pnl, 5);
});

test('a flatten with no bid leaves the position for settlement', () => {
  // Without executable depth, leave the position open for settlement.
  const p = new Portfolio();
  const b = mkBook({ asks: [[0.50, 1000]], bids: [] });
  p.execute({ book: b, ts: 1, marketId: '0xm', order: { side: 'UP', size: 100, limit: 1 } });
  p.flatten('0xm', b, 2);
  assert.equal(p.sizeOf('0xm', 'UP'), 100);
  assert.equal(p.trades.length, 0);
  const [t] = p.settle('0xm', 'UP', 3);
  near(t.pnl, 50);
});

// ---------------------------------------------------------------------------
// fees
// ---------------------------------------------------------------------------

test('fees are charged on notional at entry and exit', () => {
  const p = new Portfolio({ feeBps: 100 }); // 1%
  const b = mkBook({ asks: [[0.50, 1000]], bids: [[0.50, 1000]] });
  p.execute({ book: b, ts: 1, marketId: '0xm', order: { side: 'UP', size: 100, limit: 1 } });
  p.execute({ book: b, ts: 2, marketId: '0xm', order: { side: 'UP', size: 100, limit: null, reduce_only: true } });
  // In and out at the same price: the only loss is the two fees.
  near(p.feesPaid, 0.5 + 0.5);
  near(p.cash, -1);
  // Trade PnL includes both entry and exit fees.
  near(p.trades[0].pnl, -1);
});

test('a trade PnL always reconciles with the cash it moved', () => {
  // Realised PnL must equal cash flow for a completed round trip.
  for (const feeBps of [0, 20, 100]) {
    const p = new Portfolio({ feeBps });
    const b = mkBook({ asks: [[0.40, 1000]], bids: [[0.55, 1000]] });
    p.execute({ book: b, ts: 1, marketId: '0xm', order: { side: 'UP', size: 250, limit: 1 } });
    p.execute({ book: b, ts: 2, marketId: '0xm', order: { side: 'UP', size: 250, limit: null, reduce_only: true } });
    assert.equal(p.trades.length, 1, `feeBps=${feeBps}`);
    near(p.trades[0].pnl, p.cash);
  }
});

test('a settled trade also carries its entry fee', () => {
  const p = new Portfolio({ feeBps: 100 });
  const b = mkBook({ asks: [[0.50, 1000]] });
  p.execute({ book: b, ts: 1, marketId: '0xm', order: { side: 'UP', size: 100, limit: 1 } });
  const [t] = p.settle('0xm', 'UP', 2);
  // Paid 50 + 0.5 fee, settled at 100. Net 49.5, not 50.
  near(t.pnl, 49.5);
  near(p.cash, 49.5);
});

test('settlement charges no fee — nothing is traded', () => {
  const p = new Portfolio({ feeBps: 100 });
  const b = mkBook();
  p.execute({ book: b, ts: 1, marketId: '0xm', order: { side: 'UP', size: 100, limit: 1 } });
  const feesAfterEntry = p.feesPaid;
  p.settle('0xm', 'UP', 2);
  near(p.feesPaid, feesAfterEntry);
});

// ---------------------------------------------------------------------------
// equity
// ---------------------------------------------------------------------------

test('equity marks open positions to the bid and is flat before trading', () => {
  const p = new Portfolio();
  const b = mkBook({ asks: [[0.50, 1000]], bids: [[0.49, 1000]] });
  near(p.equity(), 0);
  p.execute({ book: b, ts: 1, marketId: '0xm', order: { side: 'UP', size: 100, limit: 1 } });
  const books = new Map([['0xm', b]]);
  near(p.equity(books), -1); // paid 50, worth 49 at the bid
});

test('with no book to mark against, an open position is held at cost', () => {
  const p = new Portfolio();
  const b = mkBook();
  p.execute({ book: b, ts: 1, marketId: '0xm', order: { side: 'UP', size: 100, limit: 1 } });
  near(p.equity(), 0, 1e-9);
});

test('equity after settlement is pure realised cash', () => {
  const p = new Portfolio();
  const b = mkBook();
  p.execute({ book: b, ts: 1, marketId: '0xm', order: { side: 'UP', size: 100, limit: 1 } });
  p.settle('0xm', 'UP', 2);
  near(p.equity(), 50);
});

// ---------------------------------------------------------------------------
// rejections
// ---------------------------------------------------------------------------

test('malformed orders are counted, not thrown', () => {
  // A strategy bug must not take the whole shard down mid-run.
  const p = new Portfolio();
  const b = mkBook();
  for (const order of [
    { side: 'SIDEWAYS', size: 10, limit: 1 },
    { side: 'UP', size: 0, limit: 1 },
    { side: 'UP', size: -5, limit: 1 },
    { size: 10, limit: 1 },
    null,
  ]) {
    assert.equal(p.execute({ book: b, ts: 1, marketId: '0xm', order }), null);
  }
  assert.equal(p.rejected, 5);
  assert.equal(p.fills.length, 0);
});

// Count invalid sizing as a rejection, without throwing or filling.
// Positivity alone admits Infinity; require finite values.
// runner/conformance applies the same cases to otengine.py.
test('every shape of unusable sizing is rejected and counted', () => {
  const book = new Book();
  book.snapshot(1000, { UP: { asks: [[0.51, 1000]], bids: [[0.49, 1000]] } });

  const cases = [
    ['an infinite notional', { side: 'UP', notional: Infinity, limit: 0.5 }],
    ['a NaN notional', { side: 'UP', notional: NaN, limit: 0.5 }],
    ['a non-numeric notional', { side: 'UP', notional: 'lots', limit: 0.5 }],
    ['a zero notional', { side: 'UP', notional: 0, limit: 0.5 }],
    ['a negative notional', { side: 'UP', notional: -5, limit: 0.5 }],
    ['an infinite limit', { side: 'UP', notional: 80, limit: Infinity }],
    ['a notional with no limit', { side: 'UP', notional: 80 }],
    ['an infinite size', { side: 'UP', size: Infinity }],
    ['a size and a notional at once', { side: 'UP', size: 10, notional: 80, limit: 0.5 }],
  ];

  for (const [what, order] of cases) {
    const pf = new Portfolio({ feeBps: 0 });
    const res = pf.execute({ book, order, ts: 1001, marketId: 'm', how: 'exit' });
    assert.equal(res, null, `${what} was executed instead of rejected`);
    assert.equal(pf.rejected, 1, `${what} was not counted as a rejection`);
    assert.equal(pf.fills.length, 0, `${what} produced a fill row`);
  }
});

// ---------------------------------------------------------------------------
// book_age: taker size by the age of the level it took
// ---------------------------------------------------------------------------

const PY_ENGINE = fileURLToPath(new URL('../harness/python/', import.meta.url));

/** The same scenario in the Python engine, its counters as JSON. */
function pyBookAge() {
  const code = `
import json, otengine as e
b = e.Book("0xm")
b.snapshot(1000, {"UP": {"asks": [[0.50, 100], [0.51, 200], [0.52, 300]], "bids": []}})
b.delta(5000, "UP", "asks", 0.51, 150)
s = e.new_book_age()
p = e.Portfolio(book_age=s)
p.execute(b, {"side": "UP", "size": 400, "limit": 0.55}, 7000, "0xm")
p.execute(b, {"side": "UP", "size": 50, "limit": 0.55}, 40000, "0xm")
g = e.Book("0xg")
g.snapshot(0, {"UP": {"asks": [[0.5, 10]], "bids": []}})
p.exclude_book_age("0xg")
p.execute(g, {"side": "UP", "size": 10, "limit": 0.55}, 90000, "0xg")
print(json.dumps(s))
`;
  return JSON.parse(execFileSync(process.env.OT_PYTHON || 'python3', ['-c', code], { cwd: PY_ENGINE, encoding: 'utf8' }));
}

test('book_age counts taker size by the age of each level taken, worked by hand', () => {
  const b = new Book('0xm');
  b.snapshot(1000, { UP: { asks: [[0.50, 100], [0.51, 200], [0.52, 300]], bids: [] } });
  b.delta(5000, 'UP', 'asks', 0.51, 150);          // this level is newer
  const s = newBookAge();
  const p = new Portfolio({ bookAge: s });
  // At 7000: 100 @0.50 (set 1000, age 6000), 150 @0.51 (set 5000, age 2000), 150 @0.52 (age 6000).
  p.execute({ book: b, ts: 7000, marketId: '0xm', order: { side: 'UP', size: 400, limit: 0.55 } });
  // At 40000: 50 @0.52, age 39000.
  p.execute({ book: b, ts: 40000, marketId: '0xm', order: { side: 'UP', size: 50, limit: 0.55 } });
  // Own-data markets are not thinned and are not counted.
  const g = new Book('0xg');
  g.snapshot(0, { UP: { asks: [[0.5, 10]], bids: [] } });
  p.excludeBookAge('0xg');
  p.execute({ book: g, ts: 90000, marketId: '0xg', order: { side: 'UP', size: 10, limit: 0.55 } });

  assert.deepEqual(s, { fills: 2, size_micro: 450e6, by_age_micro: [0, 150e6, 250e6, 50e6], max_age_ms: 39000 });
  assert.deepEqual(bookAgeReport(s), {
    taker_fills: 2,
    taker_size: 450,
    size_by_level_age: { under_1s: 0, '1s_to_5s': 150, '5s_to_30s': 250, over_30s: 50 },
    share_over_1s: 1,
    max_level_age_ms: 39000,
    note: bookAgeReport(s).note,
  });
  assert.equal(bookAgeReport(newBookAge()), null, 'no taker size: no block');
  assert.deepEqual(pyBookAge(), s, 'the Python engine counts differently');
});
