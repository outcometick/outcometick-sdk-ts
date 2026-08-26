// The Node harness, run as a real subprocess against a real job directory.
//
// Called out of process on purpose: the harness's contract is "given this
// directory, write these files and exit with this code", and a test that
// imported it would prove none of that.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANNEL, EXIT, parseTrade, parseFill, parseResult, parseOutputLine } from '../protocol.mjs';

const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'harness.mjs');

const MARKET = {
  market_id: '0xm1', asset: 'BTCUSD', interval: '1h',
  strike: 65000, outcome: 'UP', close_ts_ms: 10_000,
};

const book = (ts, upAsk = 0.50, upBid = 0.49) => ({
  kind: 'book', ts_ms: ts, snapshot: true,
  levels: {
    UP: { asks: [[upAsk, 1000]], bids: [[upBid, 1000]] },
    DOWN: { asks: [[1 - upBid, 1000]], bids: [[1 - upAsk, 1000]] },
  },
});
const tick = (ts, value) => ({ kind: 'tick', ts_ms: ts, market_id: '0xm1', value });

const EVENTS = [book(1000), tick(1001, 65100), tick(1002, 65200), tick(1003, 65300)];

/** Build a job directory and run the harness over it. */
async function runHarness({ strategy, job = {}, events = EVENTS, markets = null }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ot-harness-'));
  const src = path.join(dir, 'src');
  const out = path.join(dir, 'out');
  await mkdir(src, { recursive: true });
  await mkdir(out, { recursive: true });
  // Mirrors the image layout: the SDK is a resolvable package ABOVE the
  // strategy, because Node walks node_modules upward from the importing file.
  const sdkDir = path.join(dir, 'node_modules', 'outcometick');
  await mkdir(sdkDir, { recursive: true });
  const realSdk = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sdk');
  await cp(realSdk, sdkDir, { recursive: true });
  await writeFile(path.join(src, 'strategy.mjs'), strategy);

  const outputKey = 'a1b2c3d4'.repeat(8);
  const { markets: _drop, ...jobRest } = job;
  const full = {
    outputKey,
    entry: { file: 'strategy.mjs', className: 'S' },
    hooks: { on_market_open: 'onMarketOpen', on_tick: 'onTick' },
    arities: { on_market_open: 3, on_tick: 3 },
    params: { size: 100 },
    mode: 'market',
    seed: 7,
    feeBps: 0,
    fillDelayMs: 0,
    limits: { perEventBudgetMicros: 400, logBytesPerRun: 60, logLineChars: 512 },
    ...jobRest,
  };
  const marketList = markets ?? [{ market: MARKET, stream: 'prices' }];

  const lines = [];
  let forged = 0;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HARNESS, dir], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let tail = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => {
      tail += d;
      const parts = tail.split('\n');
      tail = parts.pop();
      for (const line of parts) {
        if (!line) continue;
        const parsed = parseOutputLine(outputKey, line);
        if (parsed) lines.push(parsed);
        else forged += 1;
      }
    });
    child.on('error', reject);
    child.on('close', (c) => resolve({ code: c, stderr }));
    // The job and the events go in on stdin, exactly as the worker sends them.
    child.stdin.on('error', () => {});
    child.stdin.write(`${JSON.stringify(full)}\n`);
    for (const m of marketList) {
      const evs = m.events === 'MISSING' ? [] : events;
      child.stdin.write(`${JSON.stringify({ market: m.market, stream: m.stream, n: evs.length })}\n`);
      for (const e of evs) child.stdin.write(`${JSON.stringify(e)}\n`);
    }
    child.stdin.end();
  });

  const pick = (ch) => lines.filter((l) => l.channel === ch).map((l) => l.payload);
  const result = parseResult(JSON.parse(pick(CHANNEL.result)[0] ?? '{}'));
  const trades = pick(CHANNEL.trade).map((p) => parseTrade(JSON.parse(p))).filter(Boolean);
  const fills = pick(CHANNEL.fill).map((p) => parseFill(JSON.parse(p))).filter(Boolean);
  const logs = pick(CHANNEL.log).join('\n');

  await rm(dir, { recursive: true, force: true });
  return { ...code, result, trades, fills, logs, forged };
}

const BUY_ONCE = `export class S {
  onMarketOpen(ctx, market) { this.done = false; }
  onTick(ctx, tick) {
    if (this.done) return null;
    this.done = true;
    return { side: "UP", size: ctx.p.size, limit: 0.60 };
  }
}`;

// ---------------------------------------------------------------------------
// the happy path
// ---------------------------------------------------------------------------

test('a strategy runs and its trade comes back through the logs', async () => {
  const r = await runHarness({ strategy: BUY_ONCE });
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(r.result.marketsRun, 1);
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].market_id, '0xm1');
  assert.equal(r.trades[0].side, 'UP');
  assert.equal(r.trades[0].how, 'settled');
  // Bought 100 at 0.50, settled UP at 1.00.
  assert.ok(Math.abs(r.trades[0].pnl - 50) < 1e-9);
  assert.equal(r.fills.length, 1);
  assert.equal(r.fills[0].action, 'open');
});

test('the market summary carries the closing quote for the baselines', async () => {
  const r = await runHarness({ strategy: BUY_ONCE });
  const m = r.result.marketSummaries[0];
  assert.equal(m.market_id, '0xm1');
  assert.equal(m.outcome, 'UP');
  assert.equal(m.up_px, 0.50);
  assert.equal(m.stream, 'prices');
});

test('the budget summary is always reported, even on a clean run', async () => {
  const r = await runHarness({ strategy: BUY_ONCE });
  assert.ok(r.result.budget);
  assert.ok(r.result.budget.events > 0);
  assert.equal(r.result.budget.limit_micros, 400);
});

// ---------------------------------------------------------------------------
// entry resolution
// ---------------------------------------------------------------------------

test('a missing class is E_ENTRY and names what was exported', async () => {
  const r = await runHarness({ strategy: 'export class Other { onTick() { return null; } }' });
  assert.equal(r.code, EXIT.rejected);
  assert.equal(r.result.rejection.code, 'E_ENTRY');
  assert.match(r.result.rejection.detail, /Other/);
});

test('a default export is accepted only when its name matches', async () => {
  const named = await runHarness({ strategy: `export default class S {
    onMarketOpen() {} onTick() { return null; }
  }` });
  assert.equal(named.code, EXIT.ok, named.stderr);

  const anon = await runHarness({ strategy: 'export default class { onTick() { return null; } }' });
  assert.equal(anon.code, EXIT.rejected);
  assert.equal(anon.result.rejection.code, 'E_ENTRY');
});

test('a module that will not load is a rejection, not a crash', async () => {
  const r = await runHarness({ strategy: 'this is not javascript' });
  assert.equal(r.code, EXIT.rejected);
  assert.equal(r.result.rejection.code, 'E_ENTRY');
});

// ---------------------------------------------------------------------------
// hooks
// ---------------------------------------------------------------------------

test('a declared hook that is not defined is E_HOOK_SIG', async () => {
  const r = await runHarness({
    strategy: 'export class S { onMarketOpen() {} }',
    job: { hooks: { on_market_open: 'onMarketOpen', on_tick: 'onTick' } },
  });
  assert.equal(r.code, EXIT.rejected);
  assert.equal(r.result.rejection.code, 'E_HOOK_SIG');
  assert.match(r.result.rejection.detail, /onTick/);
});

test('an undeclared hook is never called', async () => {
  // onTrade exists on the class but is not in the manifest, so it must not
  // fire — and the run must still succeed.
  const r = await runHarness({
    strategy: `export class S {
      onMarketOpen() {}
      onTick() { return null; }
      onTrade() { throw new Error("must not be called"); }
    }`,
  });
  assert.equal(r.code, EXIT.ok, r.stderr);
});

// ---------------------------------------------------------------------------
// failures inside the strategy
// ---------------------------------------------------------------------------

test('a strategy that throws is a rejection naming the market and the hook', async () => {
  const r = await runHarness({
    strategy: 'export class S { onMarketOpen() {} onTick() { throw new Error("boom"); } }',
  });
  assert.equal(r.code, EXIT.rejected);
  assert.equal(r.result.rejection.code, 'E_RUNTIME');
  assert.match(r.result.rejection.detail, /0xm1/);
  assert.match(r.result.rejection.detail, /on_tick threw: boom/);
});

test('a rejection still writes a result file — nothing is billed, but the reason is returned', async () => {
  const r = await runHarness({ strategy: 'export class S { onTick() { throw new Error("x"); } }' });
  assert.ok(r.result.rejection, 'the submitter has to be told why');
  assert.ok(r.result.budget, 'and what it cost to find out');
});

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

test('logs are captured, prefixed by market, and capped by bytes', async () => {
  const r = await runHarness({
    strategy: `export class S {
      onMarketOpen() {}
      onTick(ctx) { for (let i = 0; i < 5; i++) ctx.log("line " + i); return null; }
    }`,
  });
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.logs, /^0xm1 /m);
  const lines = r.logs.trim().split('\n');
  // 3 ticks x 5 lines = 15 lines of ~12 bytes each = ~180 bytes, cut short by
  // the job's 60-byte budget. The first fixture used 220 and every line fitted
  // — a cap that is not reached proves nothing about a cap.
  assert.ok(lines.length < 15, `${lines.length} lines got through a 60-byte budget`);
  assert.equal(r.result.logTruncated, true);
  // AND THE READER IS TOLD, in the log itself. A log that simply stops reads as
  // a strategy that stopped calling ctx.log, and sends someone hunting for a
  // bug in their own code.
  assert.match(r.logs, /log budget spent/,
    'the log was truncated without saying so — the reader is left to guess');
});

test('the log budget is spent across the whole run, not per market', async () => {
  // The hole this replaced: the budget was created inside replayMarket, so
  // every market got a fresh one. polymarket runs ~386 markets a day, so the
  // documented cap was really 386x itself, and ctx.log became a bulk export
  // channel for the data we sell.
  //
  // Three markets, one 60-byte budget. If the budget is shared, market 1 spends
  // it and the later markets log NOTHING. If it is per-market, each one gets a
  // fresh 60 bytes and market 3 logs just as freely as market 1 — which is the
  // bug, and is what makes this assertion discriminating.
  const r = await runHarness({
    strategy: `export class S {
      onMarketOpen() {}
      onTick(ctx) { for (let i = 0; i < 5; i++) ctx.log("line " + i); return null; }
    }`,
    markets: [
      { market: MARKET, stream: 'prices' },
      { market: { ...MARKET, market_id: '0xm2' }, stream: 'prices' },
      { market: { ...MARKET, market_id: '0xm3' }, stream: 'prices' },
    ],
  });
  assert.equal(r.code, EXIT.ok, r.stderr);

  const strategyLines = r.logs.trim().split('\n').filter((l) => /^0x\w+ /.test(l));
  const later = strategyLines.filter((l) => l.startsWith('0xm2 ') || l.startsWith('0xm3 '));
  assert.equal(later.length, 0,
    `markets after the first still logged ${later.length} lines — the budget reset per market`);

  // And the total really is bounded by the job's budget, which is the property
  // the archive's logs.txt depends on.
  const bytes = strategyLines.reduce((n, l) => n + l.length + 1, 0);
  assert.ok(bytes <= 60 + 40,
    `${bytes} bytes of strategy log got through a 60-byte budget`);
  assert.equal(r.result.logTruncated, true);
});

// ---------------------------------------------------------------------------
// modes
// ---------------------------------------------------------------------------

test('market mode resets instance state between markets', async () => {
  const events2 = 'events-1.jsonl';
  const r = await runHarness({
    strategy: `export class S {
      onMarketOpen(ctx, m) { this.seen = (this.seen ?? 0) + 1; }
      onTick(ctx) { ctx.log("seen=" + this.seen); return null; }
    }`,
    markets: [
      { market: MARKET, stream: 'prices' },
      { market: { ...MARKET, market_id: '0xm2' }, stream: 'prices' },
    ],
  });
  void events2;
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(r.result.marketsRun, 2);
  // A fresh instance per market means the counter never reaches 2 — which is
  // exactly what lets the run be sharded across workers.
  assert.ok(!/seen=2/.test(r.logs), 'state must not survive a market boundary');
});

test('session mode carries one instance and one portfolio across markets', async () => {
  const r = await runHarness({
    strategy: `export class S {
      onMarketOpen(ctx, m) { this.seen = (this.seen ?? 0) + 1; }
      onTick(ctx) { ctx.log("seen=" + this.seen); return null; }
    }`,
    job: { mode: 'session' },
    markets: [
      { market: MARKET, stream: 'prices' },
      { market: { ...MARKET, market_id: '0xm2' }, stream: 'prices' },
    ],
  });
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.logs, /seen=2/, 'session mode is exactly the mode where state survives');
});

// ---------------------------------------------------------------------------
// fees and delay
// ---------------------------------------------------------------------------

test('fees come from the job, not from the strategy params', async () => {
  const r = await runHarness({ strategy: BUY_ONCE, job: { feeBps: 100 } });
  assert.equal(r.code, EXIT.ok, r.stderr);
  // 100 contracts at 0.50 = 50 notional, 1% = 0.50.
  assert.ok(Math.abs(r.result.feesPaid - 0.5) < 1e-9);
});

test('a fill delay prices against the later book', async () => {
  const events = [
    book(1000, 0.50, 0.49),
    tick(1000, 65100),
    book(1500, 0.80, 0.79),
    tick(2000, 65200),
  ];
  // A limit high enough that the delayed price still clears it, so what is
  // being measured is the price move rather than the limit.
  const PATIENT = BUY_ONCE.replace('limit: 0.60', 'limit: 0.95');
  const instant = await runHarness({ strategy: PATIENT, events });
  const late = await runHarness({ strategy: PATIENT, events, job: { fillDelayMs: 600 } });
  assert.equal(instant.fills[0].avg_px, 0.50);
  assert.equal(late.fills[0].avg_px, 0.80, 'the delayed fill pays the later price');
});

test('a limit still protects a delayed fill', async () => {
  // The other half, and the one that matters more: if the price runs past the
  // limit while the order is in flight, it does NOT fill. An engine that filled
  // it anyway would be inventing a price the strategy refused to pay.
  const events = [
    book(1000, 0.50, 0.49),
    tick(1000, 65100),
    book(1500, 0.80, 0.79),
    tick(2000, 65200),
  ];
  const late = await runHarness({ strategy: BUY_ONCE, events, job: { fillDelayMs: 600 } });
  assert.equal(late.fills.length, 1);
  assert.equal(late.fills[0].filled, 0);
  assert.equal(late.fills[0].unfilled, 100);
  assert.equal(late.fills[0].avg_px, null);
  assert.equal(late.trades.length, 0, 'nothing filled, so there is no trade');
});

// ---------------------------------------------------------------------------
// missing data
// ---------------------------------------------------------------------------

test('a market with no events still runs and is counted', async () => {
  // The old version of this test covered "the harness could not open the event
  // file". There is no file any more — the worker streams events in, and a
  // market it could not read is simply never sent. A market that arrives with
  // zero events is a real (if empty) market-day.
  const r = await runHarness({
    strategy: BUY_ONCE,
    markets: [
      { market: MARKET, stream: 'prices' },
      { market: { ...MARKET, market_id: '0xgone' }, events: 'MISSING', stream: 'prices' },
    ],
  });
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(r.result.marketsRun, 2);
  assert.equal(r.result.marketSummaries.length, 2);
});

// ---------------------------------------------------------------------------
// submitted file names
// ---------------------------------------------------------------------------

test('a strategy in a subdirectory loads', async () => {
  // SAFE_NAME permits `helpers/z.mjs`, so the harness has to be able to import
  // one — and the worker has to have created the parent directory.
  const dir = await mkdtemp(path.join(tmpdir(), 'ot-harness-sub-'));
  const src = path.join(dir, 'src');
  const out = path.join(dir, 'out');
  await mkdir(path.join(src, 'helpers'), { recursive: true });
  await mkdir(out, { recursive: true });
  await writeFile(path.join(src, 'helpers', 'z.mjs'), 'export const SIZE = 42;\n');
  await writeFile(path.join(src, 'strategy.mjs'), `import { SIZE } from "./helpers/z.mjs";
export class S {
  onMarketOpen() {}
  onTick(ctx) { ctx.log("size=" + SIZE); return null; }
}`);
  const subKey = 'f'.repeat(64);
  let subLogs = '';
  const { code } = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HARNESS, dir], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => {
      for (const line of String(d).split('\n')) {
        const p = line ? parseOutputLine(subKey, line) : null;
        if (p && p.channel === CHANNEL.log) subLogs += `${p.payload}\n`;
      }
    });
    child.on('error', reject);
    child.on('close', (c) => resolve({ code: c, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.write(`${JSON.stringify({
      outputKey: subKey,
      entry: { file: 'strategy.mjs', className: 'S' },
      hooks: { on_market_open: 'onMarketOpen', on_tick: 'onTick' },
      arities: {}, params: {}, mode: 'market', seed: 1, feeBps: 0, fillDelayMs: 0,
      limits: { perEventBudgetMicros: 400, logBytesPerRun: 1 << 20, logLineChars: 512 },
    })}\n`);
    child.stdin.write(`${JSON.stringify({ market: MARKET, stream: 'prices', n: EVENTS.length })}\n`);
    for (const e of EVENTS) child.stdin.write(`${JSON.stringify(e)}\n`);
    child.stdin.end();
  });
  await rm(dir, { recursive: true, force: true });

  assert.equal(code, EXIT.ok);
  assert.match(subLogs, /size=42/);
});

test('params do not leak between markets', async () => {
  // One shared params object across per-market instances let a strategy that
  // wrote to ctx.p in market 1 change its own behaviour in market 2 — the exact
  // cross-market state that the per-market reset exists to prevent.
  const r = await runHarness({
    strategy: `export class S {
      onMarketOpen() {}
      onTick(ctx) { ctx.log("size=" + ctx.p.size); ctx.p.size = 9999; return null; }
    }`,
    markets: [
      { market: MARKET, stream: 'prices' },
      { market: { ...MARKET, market_id: '0xm2' }, stream: 'prices' },
    ],
  });
  assert.equal(r.code, EXIT.ok, r.stderr);
  // 9999 legitimately appears within market 1 — the strategy wrote it on its
  // own first tick and reads it back on the next two. What must NOT happen is
  // market 2 starting from it.
  const firstOfMarket2 = r.logs.split('\n').find((l) => l.startsWith('0xm2 '));
  assert.match(firstOfMarket2, /size=100$/,
    `market 2 started from a value market 1 wrote: ${firstOfMarket2}`);
});

// ---------------------------------------------------------------------------
// the strategy must not be able to rewrite what the harness reports
// ---------------------------------------------------------------------------

test('a strategy cannot tamper with the output serializer', async () => {
  // The harness shares a process with the strategy, so JSON.stringify and
  // Object.prototype.toJSON are both in reach and both pass the analyser.
  // Either would have let a strategy rewrite its rows on the way out.
  const r = await runHarness({
    strategy: `export class S {
      onMarketOpen() {
        JSON.stringify = () => JSON.stringify({ market_id: "0xfake", side: "UP", size: 1, pnl: 999999 });
        Object.prototype.toJSON = function () { return { market_id: "0xfake", side: "UP", size: 1, pnl: 999999 }; };
      }
      onTick(ctx) {
        if (this.done) return null;
        this.done = true;
        return { side: "UP", size: 100, limit: 0.60 };
      }
    }`,
  });
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].market_id, '0xm1', 'the real market, not the fabricated one');
  // Bought 100 at 0.50, settled UP.
  assert.ok(Math.abs(r.trades[0].pnl - 50) < 1e-9, `pnl was rewritten: ${r.trades[0].pnl}`);
});

test('only known fields reach the output', async () => {
  // Rows are projected onto a null-prototype object field by field, so a getter
  // or an extra key cannot ride along.
  const r = await runHarness({ strategy: BUY_ONCE });
  const extras = Object.keys(r.trades[0]).filter((k) => !(
    ['market_id', 'side', 'size', 'entry_px', 'exit_px', 'pnl', 'fees',
      'opened_ms', 'closed_ms', 'how', 'outcome'].includes(k)
  ));
  assert.deepEqual(extras, [], `unexpected fields in a trade row: ${extras}`);
});

// ---------------------------------------------------------------------------
// the documented import form
// ---------------------------------------------------------------------------

test('the SDK import the docs show actually resolves', async () => {
  // Every sample — the docs page, the editor, the analyser's happy path — says
  // `import { Strategy, Order } from "outcometick"`. Nothing tested that it
  // RESOLVES, and it did not: the Node image had no such package, so a valid
  // customer submission passed free validation and then failed at load inside
  // the sandbox, after the run was queued.
  const r = await runHarness({
    strategy: `import { Strategy, Order } from "outcometick";

export class S extends Strategy {
  onMarketOpen(ctx, market) { this.done = false; }
  onTick(ctx, tick) {
    if (this.done) return null;
    this.done = true;
    return new Order({ side: "UP", size: ctx.p.size, limit: 0.60 });
  }
}`,
  });
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].side, 'UP');
  assert.ok(Math.abs(r.trades[0].pnl - 50) < 1e-9);
});

test('the SDK Order refuses an impossible order at construction', async () => {
  // Better a clear rejection naming the field than a silently clamped order
  // the strategy never asked for.
  const r = await runHarness({
    strategy: `import { Strategy, Order } from "outcometick";
export class S extends Strategy {
  onMarketOpen() {}
  onTick() { return new Order({ side: "UP", size: 100, limit: 1.5 }); }
}`,
  });
  assert.equal(r.code, EXIT.rejected);
  assert.equal(r.result.rejection.code, 'E_RUNTIME');
  assert.match(r.result.rejection.detail, /limit must be between 0 and 1/);
});

test('holdS and hold_s both work', async () => {
  // The Node docs write holdS; the wire field is hold_s. Neither should be a
  // trap for someone copying from the page.
  for (const spelling of ['holdS: 2', 'hold_s: 2']) {
    const r = await runHarness({
      strategy: `import { Strategy, Order } from "outcometick";
export class S extends Strategy {
  onMarketOpen() { this.done = false; }
  onTick() {
    if (this.done) return null;
    this.done = true;
    return new Order({ side: "UP", size: 100, limit: 0.60, ${spelling} });
  }
}`,
      events: [book(1000), tick(1000, 1), tick(3000, 1), tick(5000, 1)],
    });
    assert.equal(r.code, EXIT.ok, r.stderr);
    assert.equal(r.trades[0].how, 'hold_expired', `${spelling} was ignored`);
  }
});

test('result.json cannot be forged through prototype pollution', async () => {
  // The rows were projected but `result` was still an ordinary object written
  // after untrusted code had run, and Object.prototype.toJSON reaches every
  // ordinary object — so markets_run, fees_paid, crosschecks and the budget
  // summary were all still rewritable at the root.
  const r = await runHarness({
    strategy: `export class S {
      onMarketOpen() {
        Object.prototype.toJSON = function () {
          return { markets_run: 99999, fees_paid: -1000, crosschecks: [], budget: null };
        };
      }
      onTick() { return null; }
    }`,
  });
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(r.result.marketsRun, 1, 'the real count, not the forged one');
  assert.equal(r.result.feesPaid, 0);
  assert.ok(r.result.budget, 'the budget summary must survive');
});

// ---------------------------------------------------------------------------
// the future must not be in the process
// ---------------------------------------------------------------------------

test('a strategy cannot steal the market before its first hook', async () => {
  // The harness used to buffer a whole market's events into an array before
  // replay began — so the future WAS in the process, and a strategy imported
  // before that buffering only had to intercept something the harness used to
  // fill it. `JSON.parse = …` and `Array.prototype.push = …` both pass static
  // analysis, and either one hands over every tick of the market. It could then
  // trade on data it should not have, and the engine would execute those orders
  // for real: not a forged report, a genuinely computed one that means nothing.
  //
  // Events are now pulled one at a time by the replay loop, so there is nothing
  // to steal. Whatever an intercepted parser sees is the event the strategy is
  // about to be handed anyway.
  const events = Array.from({ length: 50 }, (_, i) => tick(1000 + i, 100 + i));
  const r = await runHarness({
    events,
    strategy: `
const stolen = [];
const realParse = JSON.parse;
JSON.parse = function (s) { const v = realParse(s); if (v && v.kind === "tick") stolen.push(v.value); return v; };
const realPush = Array.prototype.push;
Array.prototype.push = function (...a) { for (const x of a) if (x && x.kind === "tick") stolen.push(x.value); return realPush.apply(this, a); };

export class S {
  onMarketOpen() { this.first = true; }
  onTick(ctx) {
    if (this.first) { this.first = false; ctx.log("stolen=" + stolen.length); }
    return null;
  }
}`,
  });
  assert.equal(r.code, EXIT.ok, r.stderr);
  const stolen = Number(/stolen=(\d+)/.exec(r.logs)?.[1]);
  // At most the current row. Before the fix this was all 50.
  assert.ok(stolen <= 1, `a strategy saw ${stolen} ticks before its first hook fired`);
});
