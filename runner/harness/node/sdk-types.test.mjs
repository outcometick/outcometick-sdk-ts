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
