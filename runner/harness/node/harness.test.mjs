// Exercise the Node harness as a subprocess: job input, output files and exit codes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANNEL, EXIT, parseTrade, parseFill, parseResult, parseOutputLine } from '../protocol.mjs';
import { sessionLines } from '../../session-feed.mjs';

const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'harness.mjs');

const MARKET = {
  market_id: '0xm1', asset: 'BTCUSD', interval: '1h',
  // Include opening time to exercise real market metadata and log prefixes.
  strike: 65000, outcome: 'UP', open_ts_ms: 1_000, close_ts_ms: 10_000,
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
  // Match the image layout: Node resolves the SDK from an ancestor node_modules.
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
  // The stream exactly as the worker writes it: per-market framing, or the
  // merged session stream (runner/session-feed.mjs).
  const stdinLines = [JSON.stringify(full)];
  const eventsOf = (m) => (m.events === 'MISSING' ? [] : (Array.isArray(m.events) ? m.events : events));
  if (full.mode === 'session') {
    for await (const line of sessionLines(marketList, {
      linesOf: async (m) => eventsOf(m).map((e) => JSON.stringify(e)),
      headerOf: (m) => ({ market: m.market, stream: m.stream }),
    })) stdinLines.push(line);
  } else {
    for (const m of marketList) {
      const evs = eventsOf(m);
      stdinLines.push(JSON.stringify({ market: m.market, stream: m.stream, n: evs.length }));
      for (const e of evs) stdinLines.push(JSON.stringify(e));
    }
  }

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
    for (const line of stdinLines) child.stdin.write(`${line}\n`);
    child.stdin.end();
  });

  const pick = (ch) => lines.filter((l) => l.channel === ch).map((l) => l.payload);
  const result = parseResult(JSON.parse(pick(CHANNEL.result)[0] ?? '{}'));
  const trades = pick(CHANNEL.trade).map((p) => parseTrade(JSON.parse(p))).filter(Boolean);
  const fills = pick(CHANNEL.fill).map((p) => parseFill(JSON.parse(p))).filter(Boolean);
  const logs = pick(CHANNEL.log).join('\n');

  await rm(dir, { recursive: true, force: true });
  return { ...code, result, trades, fills, logs, forged, lines };
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
  // Ignore onTrade when it is absent from the manifest, even if implemented.
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
  // Prefix logs with readable UTC opening time and a short market id.
  assert.match(r.logs, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} 0xm1 /m,
    'the log prefix is not the market\'s opening time in readable UTC');
  assert.doesNotMatch(r.logs, /^\d{13} /m,
    'the prefix is raw epoch millis, indistinguishable from the event time beside it');
  const lines = r.logs.trim().split('\n');
  // Fifteen lines total about 180 bytes, exceeding the 60-byte budget.
  assert.ok(lines.length < 15, `${lines.length} lines got through a 60-byte budget`);
  assert.equal(r.result.logTruncated, true);
  // Include a truncation notice in the log.
  assert.match(r.logs, /log budget spent/,
    'the log was truncated without saying so — the reader is left to guess');
});

test('the log budget is spent across the whole run, not per market', async () => {
  // Three markets share one 60-byte budget; later markets get no fresh allowance.
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

  // Bound the total log output by the job budget.
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
  // A fresh instance per market keeps the counter below two.
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

test('session mode writes each market\'s rows when it settles, not all at the end', async () => {
  // Session mode must stream trades and fills to bound memory use.
  const second = { ...MARKET, market_id: '0xm2', open_ts_ms: 20_000, close_ts_ms: 30_000 };
  const r = await runHarness({
    strategy: BUY_ONCE,
    job: { mode: 'session' },
    markets: [
      { market: MARKET, stream: 'prices' },
      { market: second, stream: 'prices', events: [book(20_000), tick(20_001, 65100)] },
    ],
  });
  assert.equal(r.code, EXIT.ok, r.stderr);
  const firstFill = r.lines.findIndex((l) => l.channel === CHANNEL.fill);
  const secondDone = r.lines.findIndex((l) => l.channel === CHANNEL.progress && JSON.parse(l.payload).n === 2);
  assert.ok(firstFill >= 0 && secondDone >= 0, 'nothing to order');
  assert.ok(firstFill < secondDone, 'the first market\'s fill waited for the second market to finish');
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
  // An in-flight order must not fill after the price moves beyond its limit.
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
  // An empty streamed market-day is valid. Unreadable markets are not sent.
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
  // SAFE_NAME permits nested modules; create their parent directories and resolve imports.
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
  // Copy params per market so mutations cannot leak between instances.
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
  // 9999 is valid after market 1 mutates its params, but must not appear
  // in market 2. Find the id anywhere in the prefix, independent of layout.
  const firstOfMarket2 = r.logs.split('\n').find((l) => l.includes('0xm2 '));
  assert.match(firstOfMarket2, /size=100$/,
    `market 2 started from a value market 1 wrote: ${firstOfMarket2}`);
});

// ---------------------------------------------------------------------------
// the strategy must not be able to rewrite what the harness reports
// ---------------------------------------------------------------------------

test('a strategy cannot tamper with the output serializer', async () => {
  // Strategies can replace JSON.stringify; output serialization must stay trusted.
  const r = await runHarness({
    strategy: `export class S {
      onMarketOpen() {
        JSON.stringify = () => JSON.stringify({ market_id: "0xfake", side: "UP", size: 1, pnl: 999999 });
        // (Object.prototype.toJSON used to be tried here as well. Object.prototype
        // is now frozen before the strategy loads — see the test below.)
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
  // Project rows field by field onto null-prototype objects.
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
  // Check that the documented SDK package import resolves inside the harness.
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
  // Reject invalid fields rather than silently clamp them.
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
  // Protect result metadata as well as rows from inherited toJSON hooks.
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
  // Freeze Object.prototype before loading the strategy; reject the mutation.
  assert.equal(r.code, EXIT.rejected, r.stderr);
  assert.equal(r.result.rejection.code, 'E_RUNTIME');
  assert.match(r.result.rejection.detail, /not extensible|read.only|Cannot (add|assign)/i);
  assert.equal(r.result.marketsRun, 0, 'the real count, not the forged one');
});

test('an inherited setter on Object.prototype cannot capture engine objects', async () => {
  // Inherited setters can capture engine instances during construction.
  // Prototype freezing must also block mutations through aliases.
  for (const where of ['top', 'hook']) {
    const attack = `const O = Object; O.defineProperty(O.prototype, "pf", { configurable: true, set(v) { globalThis.stolen = this; } });`;
    const r = await runHarness({
      strategy: `${where === 'top' ? attack : ''}
export class S { onMarketOpen() { ${where === 'hook' ? attack : ''} } onTick() { return null; } }`,
    });
    assert.equal(r.code, EXIT.rejected, `${where}: ${r.stderr}`);
  }
});

test('ordinary code that sets its own toString still works under the lock', async () => {
  // decimal.js overrides inherited names on plain objects; keep that working.
  const r = await runHarness({
    strategy: `const P = {}; P.toString = function () { return "p"; }; P.valueOf = () => 7;
function F() {} F.prototype.toString = function () { return "f"; };
class E extends Error {} E.prototype.name = "E";
export class S {
  onMarketOpen(ctx) { ctx.log(String(P) + (P + 0) + String(new F()) + new E("x").name); }
  onTick() { return null; }
}`,
  });
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.logs, /p7fE/);
});

// ---------------------------------------------------------------------------
// the future must not be in the process
// ---------------------------------------------------------------------------

test('a strategy cannot steal the market before its first hook', async () => {
  // Pull one event at a time so parser interception cannot reveal future rows.
  const events = Array.from({ length: 50 }, (_, i) => tick(1000 + i, 100 + i));
  const r = await runHarness({
    events,
    strategy: `
const stolen = [];
const realParse = JSON.parse;
JSON.parse = function (s) { const v = realParse(s); if (v && v.kind === "tick") stolen.push(v.value); return v; };

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
  // Only the current row may have been parsed.
  assert.ok(stolen <= 1, `a strategy saw ${stolen} ticks before its first hook fired`);
});

test('a strategy cannot patch the built-ins the engine keeps its state in', async () => {
  // Freeze collection prototypes before strategy loading to protect internal arrays.
  const events = Array.from({ length: 5 }, (_, i) => tick(1000 + i, 100 + i));
  const atLoad = await runHarness({
    events,
    strategy: `
Array.prototype.push = function () { return 0; };
export class S { onMarketOpen() {} onTick() { return null; } }`,
  });
  assert.equal(atLoad.code, EXIT.rejected, atLoad.stderr);
  assert.match(atLoad.result.rejection.detail, /read.only|Cannot assign|not extensible/i);

  for (const patch of ['Array.prototype.filter = (f) => []', 'Map.prototype.get = () => null',
    'Object.keys = () => []', 'Array.prototype[Symbol.iterator] = function* () {}',
    'WeakSet.prototype.add = function () { return this; }',
    'Object.getPrototypeOf(function* () {}).prototype.next = () => ({ done: true })',
    'Function.prototype.call = () => null',
    // Replacing split must not expose unread rows from 64 KiB stdin chunks.
    'String.prototype.split = function () { return []; }',
    'Buffer.prototype.toString = function () { return ""; }',
    // Engine code resolves these globals by name at call time.
    'globalThis.Math = { min: () => 1e9, max: () => 1e9 }',
    'Math.min = () => 1e9']) {
    const inHook = await runHarness({
      events,
      strategy: `export class S {
        onMarketOpen() {}
        onTick() { ${patch}; return null; }
      }`,
    });
    assert.equal(inHook.code, EXIT.rejected, `${patch}: ${inHook.stderr}`);
    assert.equal(inHook.result.rejection.code, 'E_RUNTIME', patch);
  }
});


test('a market with no opening time keeps the id, without a leading space', async () => {
  // A blank timestamp would shift whitespace-separated log fields.
  const noOpen = { ...MARKET };
  delete noOpen.open_ts_ms;
  const r = await runHarness({
    strategy: `export class S {
      onMarketOpen() {}
      onTick(ctx) { ctx.log("hello"); return null; }
    }`,
    markets: [{ market: noOpen, stream: 'prices' }],
  });
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.logs, /^0xm1 /m, 'a missing opening time left a leading space');
  assert.doesNotMatch(r.logs, /^ /m);
});

// Preserve a tie as an outcome in trade rows and market summaries.
test('a TIE outcome survives the protocol parse, and nonsense does not', () => {
  const row = { market_id: '0xm1', side: 'UP', size: 1, pnl: 0, entry_px: 0.5, exit_px: 0.5, how: 'settled' };
  assert.equal(parseTrade({ ...row, outcome: 'TIE' }).outcome, 'TIE');
  assert.equal(parseTrade({ ...row, outcome: 'MAYBE' }).outcome, undefined);
  const r = parseResult({
    market_summaries: [{ market_id: '0xm1', outcome: 'TIE' }, { market_id: '0xm2', outcome: 'X' }],
  });
  assert.deepEqual(r.marketSummaries.map((m) => m.outcome), ['TIE', null]);
});
