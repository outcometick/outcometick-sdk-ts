import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Book, matchOrder, toTicks, fromTicks, PRICE_SCALE } from './book.mjs';

/** A book with a simple two-sided ladder on UP. */
function bookWithUp({ asks = [[0.50, 100], [0.51, 200], [0.53, 400]], bids = [[0.49, 150], [0.48, 300]] } = {}) {
  const b = new Book('0xmarket');
  b.snapshot(1000, { UP: { asks, bids } });
  return b;
}

// ---------------------------------------------------------------------------
// ladders
// ---------------------------------------------------------------------------

test('asks read best-cheapest and bids read best-dearest', () => {
  const b = bookWithUp();
  assert.equal(b.best('UP'), 0.50);
  assert.equal(b.bestBid('UP'), 0.49);
  assert.equal(b.mid('UP'), 0.495);
});

test('an empty side reports null rather than zero', () => {
  const b = new Book('m');
  // A missing quote is null; zero is a valid price.
  assert.equal(b.best('UP'), null);
  assert.equal(b.bestBid('UP'), null);
  assert.equal(b.mid('UP'), null);
  assert.equal(b.depth('UP'), 0);
  assert.ok(b.empty);
});

test('levels come back best-first regardless of input order', () => {
  const b = new Book('m');
  b.snapshot(1, { UP: { asks: [[0.53, 400], [0.50, 100], [0.51, 200]], bids: [[0.48, 300], [0.49, 150]] } });
  assert.deepEqual(b.levels('UP', 3), [[0.50, 100], [0.51, 200], [0.53, 400]]);
  assert.deepEqual(b.bidLevels('UP', 2), [[0.49, 150], [0.48, 300]]);
});

test('depth is bounded in the direction that is "better"', () => {
  const b = bookWithUp();
  assert.equal(b.depth('UP'), 700);
  assert.equal(b.depth('UP', 0.51), 300);   // at or below 0.51
  assert.equal(b.depth('UP', 0.49), 0);
  assert.equal(b.bidDepth('UP'), 450);
  assert.equal(b.bidDepth('UP', 0.49), 150); // at or above 0.49
});

test('a delta updates, inserts and removes a level', () => {
  const b = bookWithUp();
  b.delta(1001, 'UP', 'asks', 0.51, 50);
  assert.equal(b.depth('UP', 0.51), 150);
  b.delta(1002, 'UP', 'asks', 0.495, 25);
  assert.equal(b.best('UP'), 0.495);
  b.delta(1003, 'UP', 'asks', 0.495, 0);
  assert.equal(b.best('UP'), 0.50);
  assert.equal(b.ts, 1003);
});

test('the two outcome tokens are independent books', () => {
  const b = new Book('m');
  b.snapshot(1, {
    UP: { asks: [[0.60, 100]], bids: [[0.59, 100]] },
    DOWN: { asks: [[0.41, 80]], bids: [[0.40, 80]] },
  });
  assert.equal(b.best('UP'), 0.60);
  assert.equal(b.best('DOWN'), 0.41);
  b.delta(2, 'UP', 'asks', 0.60, 0);
  assert.equal(b.best('UP'), null);
  assert.equal(b.best('DOWN'), 0.41, 'DOWN must be untouched');
});

test('prices quantise so float noise cannot decide a fill', () => {
  assert.equal(toTicks(0.1 + 0.2), toTicks(0.3));
  assert.equal(fromTicks(toTicks(0.57)), 0.57);
  assert.equal(PRICE_SCALE, 10_000);
});

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------

test('an order inside the top level fills there entirely', () => {
  const b = bookWithUp();
  const r = matchOrder(b, { side: 'UP', size: 50, limit: 0.55 });
  assert.equal(r.filled, 50);
  assert.equal(r.unfilled, 0);
  assert.equal(r.avgPx, 0.50);
  assert.deepEqual(r.fills, [{ px: 0.50, size: 50 }]);
});

test('size beyond the top level walks the book and is priced worse', () => {
  const b = bookWithUp();
  const r = matchOrder(b, { side: 'UP', size: 250, limit: 0.55 });
  assert.equal(r.filled, 250);
  assert.deepEqual(r.fills, [{ px: 0.50, size: 100 }, { px: 0.51, size: 150 }]);
  // 100*0.50 + 150*0.51 = 126.5 over 250
  assert.equal(r.notional, 126.5);
  assert.equal(r.avgPx, 0.506);
  assert.equal(r.worstPx, 0.51);
  // Slippage uses the quote visible when the order was sent.
  assert.equal(r.quotedPx, 0.50);
});

test('nothing fills above the limit and the shortfall is reported', () => {
  const b = bookWithUp();
  const r = matchOrder(b, { side: 'UP', size: 500, limit: 0.51 });
  assert.equal(r.filled, 300);
  assert.equal(r.unfilled, 200, 'the rest is reported, never assumed filled');
  assert.equal(r.worstPx, 0.51);
});

test('an order that cannot touch the book fills nothing', () => {
  const b = bookWithUp();
  const r = matchOrder(b, { side: 'UP', size: 100, limit: 0.45 });
  assert.equal(r.filled, 0);
  assert.equal(r.unfilled, 100);
  assert.equal(r.avgPx, null);
  assert.equal(r.quotedPx, 0.50, 'the quote is still reported so slippage can be attributed');
});

test('an order larger than the whole book takes all of it', () => {
  const b = bookWithUp();
  const r = matchOrder(b, { side: 'UP', size: 5000, limit: 1 });
  assert.equal(r.filled, 700);
  assert.equal(r.unfilled, 4300);
  assert.equal(b.best('UP'), null, 'the ask side is now empty');
});

test('matching consumes depth, so two orders in one event cannot share it', () => {
  // Closing and reversing share an event without reusing consumed depth.
  const b = bookWithUp();
  const first = matchOrder(b, { side: 'UP', size: 100, limit: 0.55 });
  const second = matchOrder(b, { side: 'UP', size: 100, limit: 0.55 });
  assert.equal(first.avgPx, 0.50);
  assert.equal(second.avgPx, 0.51, 'the second order must pay up');
});

test('a reduce_only order sells into the bid, not the ask', () => {
  const b = bookWithUp();
  const r = matchOrder(b, { side: 'UP', size: 100, limit: null, reduce_only: true });
  assert.equal(r.reduceOnly, true);
  assert.equal(r.filled, 100);
  assert.equal(r.avgPx, 0.49);
  assert.equal(b.best('UP'), 0.50, 'the ask side must be untouched by an exit');
  assert.equal(b.bidDepth('UP'), 350);
});

test('a reduce_only limit is a floor, not a ceiling', () => {
  // The limit is a ceiling for buys and a floor for sells.
  const b = bookWithUp();
  const r = matchOrder(b, { side: 'UP', size: 400, limit: 0.49, reduce_only: true });
  assert.equal(r.filled, 150, 'only the 0.49 bid clears the floor');
  assert.equal(r.unfilled, 250);
});

test('an exit walks down the bids when the top one is thin', () => {
  const b = bookWithUp();
  const r = matchOrder(b, { side: 'UP', size: 300, limit: 0.40, reduce_only: true });
  assert.deepEqual(r.fills, [{ px: 0.49, size: 150 }, { px: 0.48, size: 150 }]);
  assert.equal(r.avgPx, 0.485);
});

test('a zero or negative size is a no-op, not a crash', () => {
  const b = bookWithUp();
  for (const size of [0, -5, NaN]) {
    const r = matchOrder(b, { side: 'UP', size, limit: 0.55 });
    assert.equal(r.filled, 0);
    assert.deepEqual(r.fills, []);
  }
  assert.equal(b.depth('UP'), 700, 'the book must be untouched');
});

test('an unknown side matches nothing rather than throwing mid-run', () => {
  const b = bookWithUp();
  const r = matchOrder(b, { side: 'SIDEWAYS', size: 10, limit: 1 });
  assert.equal(r.filled, 0);
  assert.equal(r.unfilled, 10);
});

test('an omitted limit takes whatever is there', () => {
  const b = bookWithUp();
  const r = matchOrder(b, { side: 'UP', size: 700, limit: null });
  assert.equal(r.filled, 700);
  assert.equal(r.worstPx, 0.53);
});

test('a snapshot drops levels with no size', () => {
  const b = new Book('m');
  b.snapshot(1, { UP: { asks: [[0.50, 0], [0.51, 100]], bids: [] } });
  assert.equal(b.best('UP'), 0.51);
});

// Sum consumed depth directly: at IEEE-754 precision, 1e308 - 1000 is
// still 1e308, so requested size minus remaining size can hide a fill.
test('an order far larger than the book reports the depth it consumed', () => {
  for (const size of [1e308, 1e300, 5000]) {
    const book = new Book();
    book.snapshot(1000, { UP: { asks: [[0.51, 400], [0.52, 600]], bids: [[0.49, 1000]] } });
    const res = matchOrder(book, { side: 'UP', size });

    assert.equal(res.filled, 1000, `size ${size} reported ${res.filled} filled from a 1000-deep book`);
    // Derived values must describe the consumed depth.
    assert.ok(res.notional > 0, `size ${size} took depth but reported no notional`);
    assert.equal(res.avgPx, res.notional / res.filled);
    assert.equal(book.ladders.UP.asks.best(), null, 'the ladder was not actually consumed');
  }
});

test('a normal order is unaffected by the change', () => {
  const book = new Book();
  book.snapshot(1000, { UP: { asks: [[0.51, 400], [0.52, 600]], bids: [[0.49, 1000]] } });
  const res = matchOrder(book, { side: 'UP', size: 500 });
  assert.equal(res.filled, 500);
  assert.equal(res.unfilled, 0);
  // 400 @ 0.51 + 100 @ 0.52
  assert.equal(Number(res.notional.toFixed(4)), Number((400 * 0.51 + 100 * 0.52).toFixed(4)));
});

// Filled plus unfilled must equal the requested size across magnitudes.
test('filled and unfilled still account for the whole request', () => {
  for (const size of [500, 5000, 1e18, 1e308]) {
    const book = new Book();
    book.snapshot(1000, { UP: { asks: [[0.51, 400], [0.52, 600]], bids: [[0.49, 1000]] } });
    const r = matchOrder(book, { side: 'UP', size });
    // Float precision absorbs the addition: 1e308 + 1000 is 1e308.
    assert.equal(r.filled + r.unfilled, size,
      `size ${size}: filled ${r.filled} + unfilled ${r.unfilled} is not the order`);
  }
});

// Top-of-book bounds have no size. They may delete stale levels, never add liquidity.
test('a bound deletes levels strictly better than itself, on both ladders', () => {
  const b = new Book('m');
  b.snapshot(100, { UP: {
    asks: [[0.44, 10], [0.45, 20], [0.46, 30]],
    bids: [[0.43, 10], [0.42, 20], [0.40, 30]],
  } });
  // "Nothing better than 0.45 to buy, nothing better than 0.42 to sell into."
  assert.equal(b.bbo(200, 'UP', 0.42, 0.45), 2);
  // Delete strictly better levels; preserve levels at the bound.
  assert.deepEqual(b.levels('UP'), [[0.45, 20], [0.46, 30]]);
  assert.deepEqual(b.bidLevels('UP'), [[0.42, 20], [0.40, 30]]);
});

test('a bound never adds a level, however far it is from the book', () => {
  const b = new Book('m');
  b.snapshot(100, { UP: { asks: [[0.90, 5]], bids: [[0.10, 5]] } });
  // Better bounds cannot create levels without a quoted size.
  assert.equal(b.bbo(200, 'UP', 0.50, 0.55), 0);
  assert.deepEqual(b.levels('UP'), [[0.90, 5]]);
  assert.deepEqual(b.bidLevels('UP'), [[0.10, 5]]);
});

test('an empty side is written as 0 or 1 and clears that ladder', () => {
  const b = new Book('m');
  b.snapshot(100, { UP: { asks: [[0.01, 5], [0.02, 5]], bids: [[0.005, 5]] } });
  // Archived no-quote sentinels are best_bid 0 and best_ask 1.
  // Ordinary strict pruning handles them without a special case.
  assert.equal(b.bbo(200, 'UP', 0, 1), 3);
  assert.deepEqual(b.levels('UP'), []);
  assert.deepEqual(b.bidLevels('UP'), []);
});

test('a level stamped the same millisecond as the bound survives it', () => {
  const b = new Book('m');
  b.snapshot(100, { UP: { asks: [[0.45, 10]], bids: [] } });
  b.delta(200, 'UP', 'asks', 0.44, 7);
  // Keep same-timestamp levels: their order relative to the bound is unknown.
  assert.equal(b.bbo(200, 'UP', null, 0.45), 0);
  assert.deepEqual(b.levels('UP'), [[0.44, 7], [0.45, 10]]);
  // One millisecond later the same bound does remove it.
  assert.equal(b.bbo(201, 'UP', null, 0.45), 1);
  assert.deepEqual(b.levels('UP'), [[0.45, 10]]);
});

test('an unusable bound changes nothing rather than emptying the ladder', () => {
  const b = new Book('m');
  const fresh = () => { b.snapshot(100, { UP: { asks: [[0.44, 10]], bids: [[0.40, 10]] } }); };
  // Reject invalid bounds before pruning. Numeric strings and booleans are
  // excluded because JS and Python coerce them differently.
  for (const bad of [NaN, Infinity, -Infinity, null, undefined, 1.5, -0.1, '0.45', true, false]) {
    fresh();
    assert.equal(b.bbo(200, 'UP', bad, bad), 0, `bound ${bad} should be ignored`);
    assert.deepEqual(b.levels('UP'), [[0.44, 10]]);
    assert.deepEqual(b.bidLevels('UP'), [[0.40, 10]]);
  }
});

test('a bound on an unknown side is refused, not silently dropped', () => {
  const b = new Book('m');
  assert.throws(() => b.bbo(200, 'SIDEWAYS', 0.4, 0.5), /unknown side/);
});
