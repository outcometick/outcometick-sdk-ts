// Guards the TypeScript declarations against drifting from the runtime.
//
// The SDK ships as plain ESM with a hand-written index.d.ts. That is not
// laziness: index.mjs is loaded directly by the API, by the worker and by the
// harness INSIDE the sandbox, none of which have a build step, and adding one
// would put a compiled artefact on the path that runs untrusted code.
//
// The cost of hand-writing is that the declarations can drift. This file is the
// price paid for that choice:
//
//   1. a real TypeScript strategy must compile under `strict`
//   2. code that should NOT type-check must fail to
//   3. every runtime export must be declared, and vice versa
//
// Without (2) in particular the first test would pass against declarations that
// typed everything as `any`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, cp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import * as sdk from './sdk/index.mjs';

const run = promisify(execFile);
const SDK_DIR = fileURLToPath(new URL('./sdk', import.meta.url));
const TSC = fileURLToPath(new URL('../../../node_modules/.bin/tsc', import.meta.url));

const TSCONFIG = {
  compilerOptions: {
    strict: true,
    target: 'es2022',
    module: 'esnext',
    moduleResolution: 'bundler',
    noEmit: true,
    skipLibCheck: false,
    types: [],
  },
};

/** Type-check `files` in a scratch directory beside a copy of the SDK. */
async function typecheck(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ot-dts-'));
  try {
    await mkdir(path.join(dir, 'sdk'), { recursive: true });
    await cp(path.join(SDK_DIR, 'index.d.ts'), path.join(dir, 'sdk', 'index.d.ts'));
    await writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify(TSCONFIG));
    for (const [name, content] of Object.entries(files)) {
      await writeFile(path.join(dir, name), content);
    }
    try {
      await run(TSC, ['--noEmit', '-p', 'tsconfig.json'], { cwd: dir });
      return { ok: true, out: '' };
    } catch (err) {
      return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a real TypeScript strategy compiles against the declarations', async () => {
  const fixture = await readFile(path.join(SDK_DIR, 'types.test-d.ts'), 'utf8');
  // The fixture imports './index.js'; in the scratch tree the SDK lives in sdk/.
  const src = fixture.replace(/'\.\/index\.js'/g, "'./sdk/index.js'");
  const { ok, out } = await typecheck({ 'strategy.ts': src });
  assert.ok(ok, `types.test-d.ts no longer compiles:\n${out}`);
});

// Each of these MUST fail to compile. If any starts passing, the declarations
// have gone loose — most likely something became `any` — and the test above
// would keep passing while telling us nothing.
const MUST_NOT_COMPILE = [
  ['a side that is not an outcome token', `
    import { Order } from './sdk/index.js';
    export const o = new Order({ side: 'SIDEWAYS', size: 1 });
  `],
  ['assigning to the read-only event clock', `
    import type { Ctx } from './sdk/index.js';
    export function f(ctx: Ctx) { ctx.now = 0; }
  `],
  ['a non-numeric size', `
    import { Order } from './sdk/index.js';
    export const o = new Order({ side: 'UP', size: 'lots' });
  `],
  ['a time-in-force the engine does not model', `
    import { Order } from './sdk/index.js';
    export const o = new Order({ side: 'UP', size: 1, tif: 'gtc' });
  `],
  ['reading the outcome from a market before settlement', `
    import type { Market } from './sdk/index.js';
    export function f(m: Market): string { return m.outcome; }
  `],
  // on_book gets the CHANGE, not the book. Declaring it as a BookView made
  // `event.best()` type-check, and it throws on the first book event.
  ['reading the book off a book event, which carries only the change', `
    import type { BookEvent } from './sdk/index.js';
    export function f(e: BookEvent) { return e.best('UP'); }
  `],
  ['treating a trade print as a settlement tick', `
    import type { TradeEvent } from './sdk/index.js';
    export function f(t: TradeEvent): number { return t.value; }
  `],
  ['a hook returning something that is not an Order', `
    import type { Ctx, Tick } from './sdk/index.js';
    import { Order } from './sdk/index.js';
    export function onTick(ctx: Ctx, t: Tick): Order | null { return 'buy'; }
  `],
  // Sizing in money: the two ways of stating a size are mutually exclusive,
  // and the money one has no meaning without a price ceiling. Both are
  // rejected at run time too — this is the version you find out about while
  // typing rather than after paying for a run.
  ['a size and a notional at once', `
    import { Order } from './sdk/index.js';
    export const o = new Order({ side: 'UP', size: 1, notional: 80, limit: 0.5 });
  `],
  ['a notional without a limit to convert it at', `
    import { Order } from './sdk/index.js';
    export const o = new Order({ side: 'UP', notional: 80 });
  `],
];

for (const [what, src] of MUST_NOT_COMPILE) {
  test(`the declarations reject ${what}`, async () => {
    const { ok, out } = await typecheck({ 'bad.ts': src });
    assert.equal(ok, false, `this was expected to be a type error but compiled:\n${src}`);
    assert.match(out, /error TS\d+/, out);
  });
}

test('every runtime export is declared, and every declared value exists', async () => {
  const dts = await readFile(path.join(SDK_DIR, 'index.d.ts'), 'utf8');

  const runtime = Object.keys(sdk).filter((k) => k !== 'default').sort();
  const declared = [...dts.matchAll(/export declare (?:const|class) (\w+)/g)]
    .map((m) => m[1]).sort();

  assert.deepEqual(runtime, declared,
    'index.mjs and index.d.ts disagree about what this package exports');

  // And the default export, which strategies in the docs use.
  assert.ok(sdk.default, 'index.mjs has no default export');
  assert.deepEqual(Object.keys(sdk.default).sort(), runtime);
  assert.match(dts, /export default/, 'index.d.ts declares no default export');
});

// The declarations against what the decoder REALLY hands a hook.
//
// on_book was declared as receiving a BookView while every engine passed the
// raw event, so `event.best()` type-checked and threw on the first book row.
// Hand-written fixtures would only prove the declarations agree with
// themselves; these events come out of runner/events.mjs, and each one is
// assigned as an object literal under `strict`, so a field the runtime sends
// that the type lacks, or a required field it does not send, is a compile error.
test('real decoded events type-check against Tick, BookEvent and TradeEvent', async () => {
  const { eventsFromRow, buildSlugIndex, indexMarkets } = await import('../../events.mjs');
  const UP = '38293413631092421766722553077150584523582731647519935429040512234425496259883';
  const DOWN = '73242593869086725011786596522214389181524388147217527609156532700137054617370';
  const slug = 'btc-updown-15m-1787184000';
  const pm = indexMarkets([{
    slug, asset: 'btc', interval_sec: 900,
    condition_id: '0x7985322c3a51af1ac5fe83cf1819cc6ae53bc4bffbe1bb581e6f5de75f58fbb3',
    token_ids: [UP, DOWN], start_sec: 1787184000, end_sec: 1787184900, resolved: true,
    outcome_prices: ['1', '0'], strike_value: '69291621054540903612416',
    raw: { cryptoMarketConfig: { twapLookbackSeconds: 60 } },
  }]);
  const pd = indexMarkets([{
    category_slug: 'btc-updown-15m-1787184000', asset: 'btc', interval_label: '15m',
    market_id: 1506747, price_feed_id: 1, start_sec: 1787184000, end_sec: 1787184900,
    start_price: '627.505', end_price: '628.265', status: 'RESOLVED',
  }], { venue: 'predict' });
  const one = (path, row, idx) => {
    const out = eventsFromRow(path, row, idx, buildSlugIndex(idx));
    assert.ok(out.length > 0, `fixture decoded to nothing for ${path}`);
    return out[0][1];
  };
  const D = '2026-08-20';
  const events = {
    Tick: [
      one(`data/chainlink-twap-60s/daily/prices/BTCUSD/BTCUSD-twap60s-prices-${D}.csv.gz`,
        { feed_ts_ms: '1787184060000', value: '69300.5' }, pm),
      one(`data/predict-fun/prices/BTCUSDT/BTCUSDT-feed1-predict-prices-${D}.csv.gz`,
        { price_feed_id: '1', publish_time: '1787184060', server_ts: '1787184060100', price: '69300.5', recv_ms: '1787184060200' }, pd),
    ],
    BookEvent: [
      one(`data/polymarket/daily/book/BTC-15m/BTC-15m-book-${D}.jsonl.gz`, {
        slug, asset_id: UP, event_ts_ms: 1787184000311,
        payload: { asks: [{ size: '10', price: '0.99' }], bids: [{ size: '10', price: '0.51' }] },
      }, pm),
      one(`data/polymarket/daily/price_change/BTC-15m/BTC-15m-price_change-${D}.jsonl.gz`, {
        slug, event_ts_ms: 1787184000203,
        payload: { price_changes: [{ side: 'BUY', size: '5', price: '0.31', asset_id: UP }] },
      }, pm),
      one(`data/predict-fun/orderbook/BTC-15M/BTC-15M-predict-orderbook-${D}.jsonl.gz`, {
        market_id: 1506747, update_ts_ms: 1787184000630,
        payload: { asks: [[0.61, 30.6]], bids: [[0.59, 55.261]] },
      }, pd),
    ],
    TradeEvent: [
      one(`data/polymarket/daily/last_trade_price/BTC-15m/BTC-15m-last_trade_price-${D}.jsonl.gz`, {
        slug, asset_id: UP, event_ts_ms: 1787184000386,
        payload: { side: 'BUY', size: '5', price: '0.52', asset_id: UP },
      }, pm),
    ],
  };
  const lines = [`import type { Tick, BookEvent, TradeEvent } from './sdk/index.js';`];
  let i = 0;
  for (const [type, list] of Object.entries(events)) {
    for (const ev of list) lines.push(`export const e${i++}: ${type} = ${JSON.stringify(ev)};`);
  }
  const { ok, out } = await typecheck({ 'events.ts': lines.join('\n') });
  assert.ok(ok, `a decoded event does not match its declared type:\n${out}\n${lines.join('\n')}`);
});
