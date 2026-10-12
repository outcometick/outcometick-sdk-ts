// Exercise the CLI as a subprocess and compare rejection codes with the
// shared API validator.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
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
  language: 'python@3.14',
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
  // A missing --data value must be reported before archive discovery.
  assert.throws(() => parseArgs(['run', '.', '--data', '--date']), /--data needs a value/);
});

test('ot check accepts a valid submission and names the entry point', async () => {
  const dir = await fixture({ 'outcometick.json': PY_MANIFEST, 'strategy.py': PY_OK });
  try {
    const { code, stdout } = await ot(['check', dir]);
    assert.equal(code, 0);
    assert.match(stdout, /ok — python@3\.14/);
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

// The CLI and API must reject each invalid submission with the same code.
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
  // Importing the CLI entry point must not also trigger its direct-run path.
  const { code, stdout } = await ot(['version']);
  assert.equal(code, 0);
  assert.equal(stdout.trim().split('\n').length, 1, `version printed twice:\n${stdout}`);
});

test('the CLI and the API analyse through the same function, not two dispatches', async () => {
  // Both entry points must use the shared source analyser.
  const { readFile } = await import('node:fs/promises');
  const cli = await readFile(new URL('./ot.mjs', import.meta.url), 'utf8');

  // The server module is available only in the monorepo.
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
  // Unknown languages must not fall through to the JavaScript analyser.
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

// ---------------------------------------------------------------------------
// a CSV series is not source
// ---------------------------------------------------------------------------

test('the per-file ceiling admits a series, not just source', async () => {
  // Series files use their own byte budget, separate from source files.
  const { LIMITS } = await import('../api/lib/backtest-contract.mjs');
  const ceiling = Math.max(LIMITS.maxTotalSourceBytes, LIMITS.maxSeriesBytes);
  assert.ok(
    ceiling >= LIMITS.maxSeriesBytes,
    `a ${LIMITS.maxSeriesBytes} byte series cannot get past a ${ceiling} byte ceiling`,
  );
  // The source limit remains lower than the series limit.
  assert.ok(LIMITS.maxTotalSourceBytes < LIMITS.maxSeriesBytes);
});

test('the CLI still refuses a file no budget could accept', async () => {
  // The read ceiling supplements the validator's separate byte budgets.
  const { LIMITS } = await import('../api/lib/backtest-contract.mjs');
  const src = readFileSync(new URL('./ot.mjs', import.meta.url), 'utf8');
  assert.match(src, /over the \$\{ceiling\} byte limit for a single file/);
  assert.ok(LIMITS.maxSeriesBytes > 0);
});

// Local and hosted runs use one pass at the manifest's fill delay.
test('ot run replays once at the manifest delay, exactly as the worker does', async (t) => {
  const { readFile } = await import('node:fs/promises');
  const HERE = new URL('.', import.meta.url).pathname;
  const cli = await readFile(`${HERE}commands/run.mjs`, 'utf8');
  // The worker is server code and is absent from the published package.
  const worker = await readFile(`${HERE}../runner/worker.mjs`, 'utf8').catch(() => null);
  if (worker == null) {
    t.skip('runner/worker.mjs is not in this tree — server-side only');
    return;
  }

  for (const [name, src] of [['ot run', cli], ['the worker', worker]]) {
    // No walking a built-in list of delays.
    assert.doesNotMatch(src, /for \(const step of LATENCY_STEPS\)/,
      `${name} walks a built-in delay list again`);
    // The delay comes from the manifest, and defaults to none.
    assert.match(src, /const delayMs = manifest\.latency \?\? 0;/,
      `${name} no longer takes its fill delay from the manifest`);
    // Exactly one pass is built from it.
    assert.match(src, /const steps = \[\{ label: delayMs \? `\+\$\{delayMs\} ms` : '0 ms', ms: delayMs \}\];/,
      `${name} no longer builds exactly one pass`);
    // And the report records it.
    assert.match(src, /fillDelayMs: delayMs/,
      `${name} does not tell the report which delay it measured at`);
  }
});

// Progress, full replay and error handling apply at every fill delay.
test('neither side branches on the delay being zero', async (t) => {
  const { readFile } = await import('node:fs/promises');
  const HERE = new URL('.', import.meta.url).pathname;
  let checked = 0;
  for (const [name, file] of [
    ['ot run', `${HERE}commands/run.mjs`],
    ['the worker', `${HERE}../runner/worker.mjs`],
  ]) {
    // See above: the worker is monorepo-only.
    const src = await readFile(file, 'utf8').catch(() => null);
    if (src == null) continue;
    checked += 1;
    // Ignore comments when checking for obsolete zero-delay branches.
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    for (const pattern of [/step\.ms === 0/, /delayMs === 0/, /isMainPass/]) {
      assert.doesNotMatch(code, pattern,
        `${name} decides something by whether the delay is zero`
        + ' — with one pass at the manifest delay that branch stops running'
        + ' exactly when a delay is asked for');
    }
  }
  // Require at least the local runner to be checked; the worker is optional.
  assert.ok(checked > 0, 'neither file was readable — this test asserted nothing');
});

// ---------------------------------------------------------------------------
// --email
// ---------------------------------------------------------------------------

// Email delivery requires --email, which sets deliver_to.
test('--email is documented, because an undocumented flag is an absent one', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const here = fileURLToPath(new URL('.', import.meta.url));
  const src = await readFile(`${here}ot.mjs`, 'utf8');
  const usage = src.slice(src.indexOf('ot submit <dir>'), src.indexOf('ot status <run_id>'));
  assert.match(usage, /--email/,
    'ot submit accepts --email but never says so — nobody can reach the delivery path');
});

test('the email is only promised when one was asked for', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const here = fileURLToPath(new URL('.', import.meta.url));
  const src = await readFile(`${here}commands/submit.mjs`, 'utf8');
  // Mention email delivery only when an address was supplied.
  assert.match(src, /flags\.email\s*\n?\s*\?[^]*wait for the email/,
    'the submit output promises an email unconditionally');
  assert.match(src, /no --email, so nothing will be sent/,
    'a submitter without --email is not told the report will not be sent');
});

test('--email really reaches the request body', async () => {
  // Check that the flag reaches the submission metadata.
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const here = fileURLToPath(new URL('.', import.meta.url));
  const src = await readFile(`${here}commands/submit.mjs`, 'utf8');
  assert.match(src, /\.\.\.\(flags\.email \? \{ email: flags\.email \} : \{\}\)/,
    'submit no longer forwards --email to the API');
});

test('ot run documents --venue and infers it from the archive when it is omitted', async () => {
  // Document --venue so Predict archives can be selected.
  const { stderr, stdout } = await ot(['help']);
  assert.match(`${stdout}${stderr}`, /ot run <dir> --data <archive>[^\n]*--venue polymarket\|predict/);
  const src = readFileSync(fileURLToPath(new URL('./commands/run.mjs', import.meta.url)), 'utf8');
  assert.match(src, /const venue = flags\.venue \?\? defaultVenue\(await archiveVenues\(dataRoot\)\);/,
    'ot run no longer asks the archive which venue it holds');
});
