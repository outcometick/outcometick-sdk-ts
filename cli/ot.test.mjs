// Tests for the `ot` CLI.
//
// The load-bearing claim is the one the docs make: `ot check` runs the SAME
// validator the queue runs, so a local pass is not rejected on submit. These
// tests assert that by driving the CLI as a real subprocess and comparing its
// rejection codes against the ones api/lib/backtest-routes.mjs would return —
// not by asserting the CLI is "correct" in isolation, which would pass even if
// the two had drifted apart completely.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { parseArgs, readSubmission, validate } from './ot.mjs';
import { dayOfPath } from './local-data.mjs';
import { BacktestRejection } from '../api/lib/backtest-contract.mjs';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('./ot.mjs', import.meta.url));

const PY_MANIFEST = {
  schema: 1,
  language: 'python@3.12',
  entry: 'strategy.py:S',
  hooks: ['on_market_open', 'on_tick'],
  datasets: ['settlement'],
  params: { size: 100 },
};

const PY_OK = `class S:
    def on_market_open(self, ctx, market):
        self.done = False

    def on_tick(self, ctx, tick):
        return None
`;

/** Write a submission directory and return its path. */
async function fixture(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ot-cli-test-'));
  for (const [name, content] of Object.entries(files)) {
    const dest = path.join(dir, name);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

/** Invoke the CLI the way a user does, never throwing on a non-zero exit. */
async function ot(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('parseArgs separates the directory from the flags', () => {
  const p = parseArgs(['check', './strat', '--json']);
  assert.equal(p.command, 'check');
  assert.equal(p.dir, './strat');
  assert.equal(p.flags.json, true);
});

test('parseArgs defaults the directory to the working directory', () => {
  assert.equal(parseArgs(['check']).dir, '.');
});

test('parseArgs refuses a value-taking flag with no value', () => {
  // `ot run . --data --date 2026-08-12` must not silently read "--date" as the
  // data root and then report "no dated files under /…/--date".
  assert.throws(() => parseArgs(['run', '.', '--data', '--date']), /--data needs a value/);
});

test('ot check accepts a valid submission and names the entry point', async () => {
  const dir = await fixture({ 'outcometick.json': PY_MANIFEST, 'strategy.py': PY_OK });
  try {
    const { code, stdout } = await ot(['check', dir]);
    assert.equal(code, 0);
    assert.match(stdout, /ok — python@3\.12/);
    assert.match(stdout, /strategy\.py:S/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ot check --json reports the resolved manifest and imports', async () => {
  const dir = await fixture({ 'outcometick.json': PY_MANIFEST, 'strategy.py': PY_OK });
  try {
    const { code, stdout } = await ot(['check', dir, '--json']);
    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.equal(out.manifest.languageId, 'python');
    assert.deepEqual(out.hooks, { on_market_open: 'on_market_open', on_tick: 'on_tick' });
    assert.ok(Array.isArray(out.imports));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ot check exits non-zero without a manifest', async () => {
  const dir = await fixture({ 'strategy.py': PY_OK });
  try {
    const { code, stderr } = await ot(['check', dir]);
    assert.equal(code, 1);
    assert.match(stderr, /no outcometick\.json/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The reason this file exists. Each case is something the queue rejects; the
// CLI has to reject it with the SAME code, or "if it passes locally it will not
// be rejected on submit" is a false statement in our own docs.
const REJECTIONS = [
  ['E_FORBIDDEN', 'import os\n', /filesystem|environment/],
  ['E_NONDETERMINISM', 'import time\n', /wall clock/],
  ['E_IMPORT', 'import pandas\n', /allowlist/],
];

for (const [expected, prelude, detail] of REJECTIONS) {
  test(`ot check reports ${expected} exactly as the queue does`, async () => {
    const source = prelude + PY_OK;
    const files = [
      { name: 'outcometick.json', content: JSON.stringify(PY_MANIFEST) },
      { name: 'strategy.py', content: source },
    ];

    // What the API would say, from the same modules the routes call.
    const fromApi = await validate(files).then(
      () => null,
      (err) => (err instanceof BacktestRejection ? err : Promise.reject(err)),
    );
    assert.ok(fromApi, `expected ${expected} from the validator`);
    assert.equal(fromApi.code, expected);

    // What the CLI says, as a subprocess.
    const dir = await fixture({ 'outcometick.json': PY_MANIFEST, 'strategy.py': source });
    try {
      const { code, stdout } = await ot(['check', dir, '--json']);
      assert.equal(code, 1);
      const out = JSON.parse(stdout);
      assert.equal(out.ok, false);
      assert.equal(out.code, fromApi.code, 'CLI and API disagree on the rejection code');
      assert.equal(out.detail, fromApi.detail, 'CLI and API disagree on the detail');
      assert.match(out.detail, detail);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('readSubmission skips node_modules, dotfiles and unrelated extensions', async () => {
  const dir = await fixture({
    'outcometick.json': PY_MANIFEST,
    'strategy.py': PY_OK,
    'notes.md': '# not source',
    '.env': 'SECRET=1',
    'node_modules/dep/index.js': 'module.exports = 1;',
    'helpers/util.py': 'X = 1\n',
  });
  try {
    const names = (await readSubmission(dir)).map((f) => f.name).sort();
    assert.deepEqual(names, ['helpers/util.py', 'outcometick.json', 'strategy.py']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ot run refuses a data root that is not an archive', async () => {
  const dir = await fixture({ 'outcometick.json': PY_MANIFEST, 'strategy.py': PY_OK });
  const empty = await mkdtemp(path.join(tmpdir(), 'ot-empty-'));
  try {
    const { code, stderr } = await ot(['run', dir, '--data', empty]);
    assert.equal(code, 1);
    assert.match(stderr, /does not look like an archive/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(empty, { recursive: true, force: true });
  }
});

test('ot run requires --data rather than guessing at one', async () => {
  const dir = await fixture({ 'outcometick.json': PY_MANIFEST, 'strategy.py': PY_OK });
  try {
    const { code, stderr } = await ot(['run', dir]);
    assert.equal(code, 1);
    assert.match(stderr, /--data is required/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ot submit refuses to run without a key, before reading anything', async () => {
  const { code, stderr } = await ot(['submit', '/nonexistent', '--assets', 'btc',
    '--from', '2026-08-01', '--to', '2026-08-02']);
  assert.equal(code, 1);
  assert.match(stderr, /OT_BACKTEST_KEY is not set/);
});

test('dayOfPath reads the day out of an archive path, or nothing', () => {
  assert.equal(dayOfPath('data/polymarket/daily/book/BTC-1h/book-2026-08-12.jsonl'), '2026-08-12');
  assert.equal(dayOfPath('data/polymarket/daily/book/BTC-1h/book.jsonl'), null);
});

test('unknown commands exit 2 with usage, not 0', async () => {
  const { code, stderr } = await ot(['frobnicate']);
  assert.equal(code, 2);
  assert.match(stderr, /unknown command/);
});

test('the bin shim runs the CLI exactly once', async () => {
  // `bin/ot.mjs` imports this file, and this file self-invokes when run
  // directly. A suffix match on the filename made both true at once and every
  // command ran twice.
  const { code, stdout } = await ot(['version']);
  assert.equal(code, 0);
  assert.equal(stdout.trim().split('\n').length, 1, `version printed twice:\n${stdout}`);
});

test('the CLI and the API analyse through the same function, not two dispatches', async () => {
  // The promise in the docs is "ot check runs the exact validator the queue
  // runs". Both sides import analyzeSource from runner/analyze/index.mjs; a
  // second dispatch reappearing on either side is how that quietly stops being
  // true, so this asserts on the source itself.
  const { readFile } = await import('node:fs/promises');
  const cli = await readFile(new URL('./ot.mjs', import.meta.url), 'utf8');

  // backtest-routes.mjs is the server and is deliberately NOT in the published
  // package, so this half only runs in the monorepo. The CLI half runs
  // everywhere — including for anyone who cloned the public mirror to check
  // the claim for themselves, which is the point of shipping these tests.
  const routes = await readFile(
    new URL('../api/lib/backtest-routes.mjs', import.meta.url), 'utf8',
  ).catch(() => null);

  const sources = [['cli', cli], ...(routes ? [['routes', routes]] : [])];
  for (const [name, src] of sources) {
    assert.match(src, /analyzeSource/, `${name} should call the shared analyser`);
    assert.doesNotMatch(src, /analyzeJavaScriptSubmission|analyzePythonSubmission/,
      `${name} dispatches to an analyser directly — that is a second validator`);
  }
});

test('the shared analyser fails closed on a language it has no analyser for', async () => {
  const { analyzeSource } = await import('../runner/analyze/index.mjs');
  // Fabricated because the contract cannot express this today. The point is
  // what happens when it can: a new language must not fall through to the
  // JavaScript analyser and be reported as clean.
  await assert.rejects(
    () => analyzeSource({ manifest: { languageId: 'golang', deps: [] }, files: [] }),
    /no analyser for golang/,
  );
});

test('a local archive walk does not follow symlinks out of the archive', async () => {
  const { symlink, writeFile: wf, mkdir: md } = await import('node:fs/promises');
  const { localDays } = await import('./local-data.mjs');

  const root = await mkdtemp(path.join(tmpdir(), 'ot-archive-'));
  const secretDir = await mkdtemp(path.join(tmpdir(), 'ot-secret-'));
  try {
    const secret = path.join(secretDir, 'id_rsa');
    await wf(secret, 'PRIVATE KEY');

    const dir = path.join(root, 'data/chainlink/daily/prices/BTCUSD');
    await md(dir, { recursive: true });
    // A file that would be picked up as a real archive file, were it not a link.
    await symlink(secret, path.join(dir, 'BTCUSD-prices-2026-08-12.csv'));
    // And a link pointing at a whole directory outside the archive.
    await symlink(secretDir, path.join(root, 'data/elsewhere'));

    // Nothing dated is visible, because the only dated path is a symlink.
    assert.deepEqual(await localDays(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(secretDir, { recursive: true, force: true });
  }
});
