// `ot mcp`, driven the way an AI tool drives it: a child process speaking
// newline-delimited JSON-RPC on stdin/stdout, against a local stand-in for the
// API that answers like the real one (including /v1/dl's 302 with the sha256
// on the redirect).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOLS, PROTOCOL_VERSIONS, MAX_FILE_ROWS, publishFile } from './mcp.mjs';

const CLI = fileURLToPath(new URL('./ot.mjs', import.meta.url));
const DATA_KEY = 'ck_test.data';
const BT_KEY = 'bt_test.backtest';
const DAY = '2026-01-02';
const BODY = Buffer.from('feed_ts_ms,value\n1,2\n');
const SHA = createHash('sha256').update(BODY).digest('hex');

let server;
let base;
const seen = [];

before(async () => {
  server = createServer(async (req, res) => {
    const u = new URL(req.url, base);
    let body = '';
    for await (const c of req) body += c;
    seen.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), auth: req.headers.authorization ?? null, body });
    const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const dataAuthed = req.headers.authorization === `Bearer ${DATA_KEY}`;
    const btAuthed = req.headers.authorization === `Bearer ${BT_KEY}`;

    if (u.pathname === '/v1/public/coverage') return json(200, { venues: { polymarket: { assets: ['BTC'] } } });
    if (u.pathname === '/v1/meta') return dataAuthed ? json(200, { firstDay: '2026-01-01', lastDay: DAY }) : json(401, { error: 'bad key' });
    if (u.pathname === '/v1/files') {
      if (!dataAuthed) return json(401, { error: 'bad key' });
      if (u.searchParams.get('date') === '2025-01-01') return json(403, { error: 'outside coverage', floor: '2026-01-01', ceiling: DAY });
      // slow, so a ping sent after it must come back first
      await new Promise((r) => setTimeout(r, 300));
      const n = Number(u.searchParams.get('n') ?? 0) || 1205;
      return json(200, { count: n, bytes: n * 10, files: Array.from({ length: n }, (_, i) => ({
        date: DAY, name: `BTCUSD-prices-${i}.csv.gz`, sha256: SHA, bytes: 10, url: `${base}/v1/dl/${DAY}/x` })) });
    }
    const dl = /^\/v1\/dl\/([\d-]+)\/([^/]+)$/.exec(u.pathname);
    if (dl) {
      if (!dataAuthed) return json(401, { error: 'bad key' });
      const sha = dl[2] === 'corrupt.csv.gz' ? '0'.repeat(64) : SHA;
      res.writeHead(302, { location: `${base}/object/${dl[2]}`, 'x-outcometick-sha256': sha });
      return res.end();
    }
    if (u.pathname.startsWith('/object/')) {
      // A presigned URL carries its own auth; our key must never arrive here.
      if (req.headers.authorization) return json(400, { error: 'key leaked to storage' });
      res.writeHead(200, { 'content-type': 'application/gzip' });
      return res.end(BODY);
    }
    if (u.pathname === '/v1/backtest/capacity') return json(200, { venue: u.searchParams.get('venue'), last_day: DAY, backtest_window_days: 35 });
    if (u.pathname === '/v1/backtest/quote') {
      const b = JSON.parse(body || '{}');
      if (b.days > 35) return json(422, { error: 'scope', code: 'E_SCOPE', detail: 'only the most recent 35 days' });
      return json(200, { ok: true, quote: { marketDays: (b.days ?? 1) * b.assets.length, credits: 7 } });
    }
    if (u.pathname === '/v1/backtest/runs') return btAuthed ? json(200, { runs: [{ run_id: 'r1', status: 'done' }] }) : json(401, { error: 'bad key' });
    if (u.pathname === '/v1/backtest/balance') return btAuthed ? json(200, { balance: 42, history: [] }) : json(401, { error: 'bad key' });
    if (u.pathname === '/v1/backtest/run/r1') return btAuthed ? json(200, { run_id: 'r1', status: 'done' }) : json(401, { error: 'bad key' });
    if (u.pathname.startsWith('/v1/backtest/run/')) return json(404, { error: 'not found' });
    return json(404, { error: 'no route' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

/**
 * Start `ot mcp` and talk to it. `send` writes one message; `next(id)` waits
 * for the response with that id. Every stdout line is kept so the test can
 * assert that NOTHING but JSON-RPC was ever written there.
 */
function startServer({ env = {}, cwd = process.cwd() } = {}) {
  const child = spawn(process.execPath, ['--experimental-strip-types', CLI, 'mcp', '--api', base], {
    cwd, env: { ...process.env, OT_KEY: '', OT_BACKTEST_KEY: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  const order = [];
  const waiters = new Map();
  let buf = '';
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      lines.push(line);
      const msg = JSON.parse(line); // throws → test fails: stdout must be pure JSON-RPC
      order.push(msg.id);
      waiters.get(msg.id)?.(msg);
    }
  });
  let nextId = 1;
  const send = (msg) => child.stdin.write(`${typeof msg === 'string' ? msg : JSON.stringify(msg)}\n`);
  const request = (method, params) => {
    const id = nextId++;
    const p = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no answer to ${method} (#${id}); stderr: ${stderr}`)), 15_000);
      waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
    });
    send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    return p;
  };
  const call = async (name, args = {}) => {
    const r = await request('tools/call', { name, arguments: args });
    const text = r.result?.content?.[0]?.text;
    return { isError: r.result?.isError === true, value: text ? JSON.parse(text) : null, raw: r };
  };
  const stop = () => new Promise((resolve) => { child.once('exit', (code) => resolve(code)); child.stdin.end(); });
  return { send, request, call, stop, lines, order, stderr: () => stderr };
}

test('handshake, tool list, and a clean exit when stdin closes', async () => {
  const s = startServer();
  const init = await s.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.protocolVersion, '2025-03-26', 'echoes a version it supports');
  assert.equal(init.result.serverInfo.name, 'outcometick');
  assert.ok(init.result.capabilities.tools);
  assert.match(init.result.instructions, /llms-full\.txt/);
  s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const list = await s.request('tools/list');
  const names = list.result.tools.map((t) => t.name);
  assert.deepEqual(names, TOOLS.map((t) => t.name));
  for (const t of list.result.tools) {
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.ok(t.description.length > 20, t.name);
    assert.equal(typeof t.annotations.readOnlyHint, 'boolean', t.name);
  }
  // Spending credits is the customer's decision, never an agent's.
  assert.ok(!names.some((n) => /submit/i.test(n)), 'a submit tool must not exist');

  assert.equal(await s.stop(), 0);
  // The notification got no answer: two requests, two responses.
  assert.equal(s.lines.length, 2, s.lines.join('\n'));
});

test('an unknown protocol version is answered with ours', async () => {
  const s = startServer();
  const init = await s.request('initialize', { protocolVersion: '1999-01-01' });
  assert.equal(init.result.protocolVersion, PROTOCOL_VERSIONS[0]);
  await s.stop();
});

test('protocol errors: bad JSON, unknown method, unknown tool', async () => {
  const s = startServer();
  s.send('{not json');
  const unknown = await s.request('resources/list');
  assert.equal(unknown.error.code, -32601);
  const tool = await s.request('tools/call', { name: 'submit', arguments: {} });
  assert.equal(tool.error.code, -32602);
  await s.stop();
  assert.ok(s.lines.some((l) => JSON.parse(l).error?.code === -32700), 'parse error reported');
});

test('public tools work without any key', async () => {
  const s = startServer();
  const cov = await s.call('coverage');
  assert.equal(cov.isError, false);
  assert.deepEqual(cov.value.venues.polymarket.assets, ['BTC']);
  const cap = await s.call('backtest_capacity', { venue: 'predict' });
  assert.equal(cap.value.venue, 'predict');
  await s.stop();
});

test('a keyed tool without its key says which variable to set', async () => {
  const s = startServer();
  const meta = await s.call('meta');
  assert.equal(meta.isError, true);
  assert.match(meta.value.error, /OT_KEY is not set/);
  const runs = await s.call('backtest_runs');
  assert.equal(runs.isError, true);
  assert.match(runs.value.error, /OT_BACKTEST_KEY is not set/);
  await s.stop();
});

test('list_files forwards the filters, drops urls and truncates with the full count', async () => {
  const s = startServer({ env: { OT_KEY: DATA_KEY } });
  seen.length = 0;
  const r = await s.call('list_files', { asset: 'BTC', interval: ['5m', 'none'], from: '2026-01-01', to: DAY });
  assert.equal(r.isError, false);
  const q = seen.find((x) => x.path === '/v1/files').query;
  assert.deepEqual(q, { from: '2026-01-01', to: DAY, asset: 'BTC', interval: '5m,none' });
  assert.equal(r.value.count, 1205, 'the full count survives truncation');
  assert.equal(r.value.returned, 200);
  assert.equal(r.value.truncated, true);
  assert.ok(r.value.files.every((f) => !('url' in f)));
  const big = await s.call('list_files', { limit: 5000 });
  assert.equal(big.isError, false);
  assert.equal(big.value.returned, MAX_FILE_ROWS);
  await s.stop();
});

test('an API refusal comes back as a readable tool error with the server body', async () => {
  const s = startServer({ env: { OT_KEY: DATA_KEY } });
  const r = await s.call('list_files', { date: '2025-01-01' });
  assert.equal(r.isError, true);
  assert.equal(r.value.status, 403);
  assert.equal(r.value.body.floor, '2026-01-01', 'the real window reaches the model');
  await s.stop();
});

test('a slow call does not hold up a ping', async () => {
  const s = startServer({ env: { OT_KEY: DATA_KEY } });
  const slow = s.call('list_files', {});
  const ping = await s.request('ping');
  assert.deepEqual(ping.result, {});
  await slow;
  assert.ok(s.order.indexOf(ping.id) < s.order.length - 1, 'ping answered before the slow call');
  await s.stop();
});

test('download_file saves into the directory and verifies the checksum', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'ot-mcp-'));
  try {
    const s = startServer({ env: { OT_KEY: DATA_KEY }, cwd: work });
    const r = await s.call('download_file', { date: DAY, name: 'BTCUSD-prices.csv.gz', dir: 'data' });
    assert.equal(r.isError, false, JSON.stringify(r.value));
    assert.equal(r.value.saved, path.join(work, 'data', 'BTCUSD-prices.csv.gz'));
    assert.equal(r.value.sha256, SHA);
    assert.equal(r.value.verified, true);
    assert.deepEqual(await readFile(r.value.saved), BODY);

    const bad = await s.call('download_file', { date: DAY, name: 'corrupt.csv.gz' });
    assert.equal(bad.isError, true);
    assert.match(bad.value.error, /checksum mismatch/);

    for (const name of ['../escape.csv.gz', 'a/b.csv.gz', '.hidden', '']) {
      const esc = await s.call('download_file', { date: DAY, name });
      assert.equal(esc.isError, true, name);
      assert.match(esc.value.error, /not an archive file name/, name);
    }
    await s.stop();
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('backtest_quote posts the scope and relays a rejection code', async () => {
  const s = startServer();
  seen.length = 0;
  const ok = await s.call('backtest_quote', { venue: 'polymarket', assets: ['BTC', 'ETH'], days: 7 });
  assert.equal(ok.value.quote.marketDays, 14);
  assert.deepEqual(JSON.parse(seen.find((x) => x.path === '/v1/backtest/quote').body),
    { venue: 'polymarket', assets: ['BTC', 'ETH'], days: 7 });
  const no = await s.call('backtest_quote', { venue: 'polymarket', assets: ['BTC'], days: 400 });
  assert.equal(no.isError, true);
  assert.equal(no.value.body.code, 'E_SCOPE');
  await s.stop();
});

test('backtest runs and status use the backtest key', async () => {
  const s = startServer({ env: { OT_BACKTEST_KEY: BT_KEY } });
  const runs = await s.call('backtest_runs');
  assert.deepEqual(runs.value, { balance: 42, runs: [{ run_id: 'r1', status: 'done' }] });
  const st = await s.call('backtest_status', { run_id: 'r1' });
  assert.equal(st.value.status, 'done');
  const missing = await s.call('backtest_status', { run_id: 'nope' });
  assert.equal(missing.isError, true);
  assert.equal(missing.value.status, 404);
  await s.stop();
});

test('check_strategy runs the queue validator locally', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ot-mcp-strat-'));
  try {
    await writeFile(path.join(dir, 'outcometick.json'), JSON.stringify({
      schema: 1, language: 'python@3.14', entry: 'strategy.py:S',
      hooks: ['on_market_open', 'on_tick'], datasets: ['settlement'], params: {},
    }));
    await writeFile(path.join(dir, 'strategy.py'),
      'class S:\n    def on_market_open(self, ctx, market):\n        pass\n\n    def on_tick(self, ctx, tick):\n        return None\n');
    const s = startServer();
    const ok = await s.call('check_strategy', { dir });
    assert.equal(ok.isError, false, JSON.stringify(ok.value));
    assert.equal(ok.value.ok, true);
    assert.equal(ok.value.language, 'python@3.14');

    // An import the sandbox does not have: the validator's answer, not a crash.
    await writeFile(path.join(dir, 'strategy.py'), 'import requests\nclass S:\n    def on_market_open(self, ctx, market):\n        pass\n\n    def on_tick(self, ctx, tick):\n        return None\n');
    const no = await s.call('check_strategy', { dir });
    assert.equal(no.isError, false);
    assert.equal(no.value.ok, false);
    assert.match(no.value.code, /^E_/);

    const empty = await mkdtemp(path.join(tmpdir(), 'ot-mcp-empty-'));
    const none = await s.call('check_strategy', { dir: empty });
    assert.equal(none.isError, true);
    assert.match(none.value.error, /no outcometick\.json/);
    await rm(empty, { recursive: true, force: true });

    // A directory that does not exist is a failure to check, not a verdict.
    const gone = await s.call('check_strategy', { dir: path.join(dir, 'does-not-exist') });
    assert.equal(gone.isError, true);
    assert.match(gone.value.error, /ENOENT/);
    await s.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the data key never reaches object storage', async () => {
  // Asserted by the stand-in itself (it answers 400 if a key arrives); this
  // makes the download path run once more and checks the request log too.
  const work = await mkdtemp(path.join(tmpdir(), 'ot-mcp-'));
  try {
    const s = startServer({ env: { OT_KEY: DATA_KEY }, cwd: work });
    seen.length = 0;
    const r = await s.call('download_file', { date: DAY, name: 'x.csv.gz' });
    assert.equal(r.isError, false, JSON.stringify(r.value));
    const obj = seen.filter((x) => x.path.startsWith('/object/'));
    assert.equal(obj.length, 1);
    assert.equal(obj[0].auth, null);
    await s.stop();
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('download_file never writes through an existing name, link or file', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'ot-mcp-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'ot-mcp-outside-'));
  try {
    const victim = path.join(outside, 'victim.txt');
    await writeFile(victim, 'precious');
    // A link planted under the archive name, pointing outside the directory.
    await symlink(victim, path.join(work, 'BTCUSD-prices.csv.gz'));
    // A dangling link too: 'wx' must refuse it, not create its target.
    await symlink(path.join(outside, 'created-through-link'), path.join(work, 'dangling.csv.gz'));
    await writeFile(path.join(work, 'existing.csv.gz'), 'old complete file');

    const s = startServer({ env: { OT_KEY: DATA_KEY }, cwd: work });
    for (const name of ['BTCUSD-prices.csv.gz', 'dangling.csv.gz', 'existing.csv.gz']) {
      const r = await s.call('download_file', { date: DAY, name });
      assert.equal(r.isError, true, name);
      assert.match(r.value.error, /already exists/, name);
    }
    await s.stop();

    assert.equal(await readFile(victim, 'utf8'), 'precious', 'the link target was written through');
    assert.deepEqual(await readdir(outside), ['victim.txt'], 'something was created outside the directory');
    assert.equal(await readFile(path.join(work, 'existing.csv.gz'), 'utf8'), 'old complete file');
    // No temp files left behind.
    assert.deepEqual((await readdir(work)).filter((n) => n.endsWith('.part')), []);
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('concurrent downloads of one file: exactly one publishes, the other is refused', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'ot-mcp-'));
  try {
    const results = await Promise.allSettled(Array.from({ length: 8 },
      () => publishFile(path.join(work, 'same.csv.gz'), BODY)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of results.filter((x) => x.status === 'rejected')) assert.match(r.reason.message, /already exists/);
    assert.deepEqual(await readFile(path.join(work, 'same.csv.gz')), BODY);
    assert.deepEqual(await readdir(work), ['same.csv.gz'], 'temp files left behind');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('a directory that is a link is reported where the file really went', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'ot-mcp-'));
  const real = await mkdtemp(path.join(tmpdir(), 'ot-mcp-real-'));
  try {
    await symlink(real, path.join(work, 'linked'));
    const s = startServer({ env: { OT_KEY: DATA_KEY }, cwd: work });
    const r = await s.call('download_file', { date: DAY, name: 'f.csv.gz', dir: 'linked' });
    assert.equal(r.isError, false, JSON.stringify(r.value));
    assert.equal(r.value.saved, path.join(await (await import('node:fs/promises')).realpath(real), 'f.csv.gz'));
    await s.stop();
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(real, { recursive: true, force: true });
  }
});

test('without hard links it falls back to an exclusive copy that still never overwrites', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'ot-mcp-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'ot-mcp-outside-'));
  const noLink = async () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); };
  try {
    await publishFile(path.join(work, 'a.csv.gz'), BODY, { linkImpl: noLink });
    assert.deepEqual(await readFile(path.join(work, 'a.csv.gz')), BODY);

    await assert.rejects(publishFile(path.join(work, 'a.csv.gz'), Buffer.from('x'), { linkImpl: noLink }), /already exists/);
    assert.deepEqual(await readFile(path.join(work, 'a.csv.gz')), BODY, 'overwritten on the fallback path');

    const victim = path.join(outside, 'victim.txt');
    await writeFile(victim, 'precious');
    await symlink(victim, path.join(work, 'b.csv.gz'));
    await assert.rejects(publishFile(path.join(work, 'b.csv.gz'), BODY, { linkImpl: noLink }), /already exists/);
    assert.equal(await readFile(victim, 'utf8'), 'precious', 'the fallback followed a link');

    // A failed copy must not delete by path. libuv removes its own partial
    // target before returning; here another download creates the name in that
    // gap, and that file must survive this one's failure.
    const racedCopy = async (src, dst) => {
      await writeFile(dst, 'partial', { flag: 'wx' });
      await rm(dst); // what libuv does on failure
      await writeFile(dst, 'another download', { flag: 'wx' }); // a concurrent caller wins the name
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
    };
    await assert.rejects(publishFile(path.join(work, 'c.csv.gz'), BODY, { linkImpl: noLink, copyImpl: racedCopy }), /no space/);
    assert.equal(await readFile(path.join(work, 'c.csv.gz'), 'utf8'), 'another download', 'deleted a file it did not create');
    assert.deepEqual((await readdir(work)).filter((n) => n.endsWith('.part')), [], 'temp left behind');

    // Any other link failure is a real error, not a reason to copy.
    const eio = async () => { throw Object.assign(new Error('io'), { code: 'EIO' }); };
    let copied = false;
    await assert.rejects(publishFile(path.join(work, 'd.csv.gz'), BODY, { linkImpl: eio, copyImpl: async () => { copied = true; } }), /io/);
    assert.equal(copied, false);
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
