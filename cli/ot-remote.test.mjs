// Tests for the CLI commands that talk to the API: `ot status` and `ot fetch`.
//
// Both exist because other parts of the CLI print them — `ot submit` tells you
// to run `ot status`, and `ot status` tells you to run `ot fetch`. These drive
// them against a stub API so the printed commands are known to work rather than
// known to be spelled correctly.
//
// Split from ot.test.mjs because these are the only tests that open a socket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('./ot.mjs', import.meta.url));

/** Invoke the CLI the way a user does, with a key present. */
async function ot(args, env = {}) {
  const options = { env: { ...process.env, OT_BACKTEST_KEY: 'bt_test', ...env } };
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], options);
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/** A stand-in API. Returns {url, close, seen}. */
async function stubApi(routes) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const route = routes[`${req.method} ${req.url.split('?')[0]}`];
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'run not found' }));
      return;
    }
    route(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const DONE_RUN = {
  run_id: 'run_abc',
  status: 'done',
  language: 'python@3.12',
  mode: 'market',
  venue: 'polymarket',
  assets: ['BTC'],
  from: '2026-08-01',
  to: '2026-08-02',
  market_days: 48,
  credits_held: 100,
  credits_spent: 96,
  rejection: null,
  report: { metrics: { net_pnl: 1234.5, trades: 17, win_rate: 0.6 } },
  archive_available: true,
  archive_bytes: 20480,
  source_sha256: 'ab'.repeat(32),
  created_ms: 1755000000000,
  started_ms: 1755000060000,
  finished_ms: 1755000600000,
};

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

test('ot status prints the run, and the refund alongside what was spent', async () => {
  const api = await stubApi({
    'GET /v1/backtest/run/run_abc': (req, res) => json(res, 200, DONE_RUN),
  });
  try {
    const { code, stdout } = await ot(['status', 'run_abc', '--api', api.url]);
    assert.equal(code, 0);
    assert.match(stdout, /run_abc/);
    assert.match(stdout, /status\s+done/);
    // Both halves of the money. A partial run bills for the market-days it
    // actually read; printing only the spend makes a refund look like an
    // overcharge.
    assert.match(stdout, /96 spent \(4 returned\)/);
    assert.match(stdout, /net pnl\s+\+\$1,234\.5/);
    assert.match(stdout, /ot fetch run_abc/);
    assert.equal(api.seen[0].auth, 'Bearer bt_test');
  } finally {
    await api.close();
  }
});

test('ot status reports a rejected run with the queue code', async () => {
  const api = await stubApi({
    'GET /v1/backtest/run/run_bad': (req, res) => json(res, 200, {
      ...DONE_RUN,
      run_id: 'run_bad',
      status: 'rejected',
      report: null,
      archive_available: false,
      credits_held: 100,
      credits_spent: 0,
      rejection: { code: 'E_FORBIDDEN', detail: 'strategy.py:1: import os' },
    }),
  });
  try {
    const { code, stdout } = await ot(['status', 'run_bad', '--api', api.url]);
    assert.equal(code, 0);
    assert.match(stdout, /E_FORBIDDEN/);
    assert.match(stdout, /import os/);
    assert.match(stdout, /0 spent \(100 returned\)/);
  } finally {
    await api.close();
  }
});

test('ot status exits non-zero for a run this key cannot see', async () => {
  const api = await stubApi({});
  try {
    const { code, stderr } = await ot(['status', 'run_nope', '--api', api.url]);
    assert.equal(code, 1);
    assert.match(stderr, /no run run_nope under this key/);
  } finally {
    await api.close();
  }
});

test('ot status needs a run id rather than defaulting to the directory', async () => {
  // parseArgs hands back '.' when there is no positional, and '.' is not a run
  // id. Sending it to the API would 404 confusingly instead of saying what is
  // actually wrong.
  const { code, stderr } = await ot(['status']);
  assert.equal(code, 1);
  assert.match(stderr, /usage: ot status <run_id>/);
});

test('ot status refuses to run without a key', async () => {
  const { code, stderr } = await ot(['status', 'run_abc'], { OT_BACKTEST_KEY: '' });
  assert.equal(code, 1);
  assert.match(stderr, /OT_BACKTEST_KEY is not set/);
});

test('ot fetch follows the presigned redirect and writes the archive', async () => {
  const zip = Buffer.from('PK stub archive bytes');
  let base = '';
  const api = await stubApi({
    'GET /v1/backtest/run/run_abc/archive': (req, res) => {
      res.writeHead(302, { location: `${base}/signed` }).end();
    },
    'GET /signed': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/zip' }).end(zip);
    },
  });
  base = api.url;
  const dir = await mkdtemp(path.join(tmpdir(), 'ot-fetch-'));
  const out = path.join(dir, 'a.zip');
  try {
    const { code, stdout } = await ot(['fetch', 'run_abc', '--api', api.url, '--out', out]);
    assert.equal(code, 0);
    assert.match(stdout, /a\.zip/);
    assert.deepEqual(await readFile(out), zip);
  } finally {
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('ot fetch distinguishes "not finished" from "no such run"', async () => {
  const api = await stubApi({
    'GET /v1/backtest/run/run_abc/archive': (req, res) => json(res, 409, {
      error: 'no archive for this run',
      status: 'running',
    }),
  });
  try {
    const { code, stderr } = await ot(['fetch', 'run_abc', '--api', api.url]);
    assert.equal(code, 1);
    assert.match(stderr, /no archive yet/);
    assert.match(stderr, /run is running/);
    assert.match(stderr, /ot status run_abc/);
  } finally {
    await api.close();
  }
});
