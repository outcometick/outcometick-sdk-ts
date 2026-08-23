// Tests for the data-subscription client.
//
// Driven against a stub whose behaviour was copied from
// api/subscription-api.mjs — the 302-with-checksum on /v1/dl, the
// date-XOR-from/to rejection, the 403 that carries floor and ceiling. The point
// is not that the client works against a friendly server; it is that it handles
// what the real routes actually do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DataClient, OutcometickError, NO_VALUE } from './data.mjs';

const PAYLOAD = gzipSync(Buffer.from('ts_ms,value\n1755000000000,65000\n'));
const SHA = createHash('sha256').update(PAYLOAD).digest('hex');

const FILE_ROW = {
  date: '2026-08-12',
  name: 'BTCUSD-prices-2026-08-12.csv.gz',
  venue: 'polymarket',
  dataset: 'prices',
  asset: 'BTCUSD',
  interval: null,
  bytes: PAYLOAD.length,
  sha256: SHA,
};

/** A stand-in for the subscription API. Records every request it sees. */
async function stubApi(overrides = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), auth: req.headers.authorization });
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };

    const custom = overrides[u.pathname];
    if (custom) return custom(req, res, u, json);

    if (u.pathname === '/v1/meta') {
      return json(200, {
        firstDay: '2026-06-08', lastDay: '2026-08-12', days: 66,
        venues: ['polymarket'], assets: ['BTCUSD', 'ETHUSD'],
        intervals: ['5m', '1h'],
        filterTokens: { noValue: 'none', appliesTo: ['interval'] },
        datasets: { prices: '1 Hz settlement stream', book: 'order book' },
        scope: { date_scope: 'rolling-30' }, sampledFrom: '2026-08-12',
      });
    }
    if (u.pathname === '/v1/mirror/days') {
      return json(200, { days: ['2026-08-11', '2026-08-12'], floor: '2026-07-14', ceiling: null });
    }
    if (u.pathname === '/v1/files') {
      if (u.searchParams.get('date') && (u.searchParams.get('from') || u.searchParams.get('to'))) {
        return json(400, { error: 'use either date, or from/to — not both' });
      }
      return json(200, {
        from: '2026-08-12', to: '2026-08-12', days: 1, count: 1,
        bytes: PAYLOAD.length,
        files: [{ ...FILE_ROW, url: 'http://x/v1/dl/2026-08-12/BTCUSD-prices-2026-08-12.csv.gz' }],
      });
    }
    if (u.pathname === '/v1/mirror/download') {
      return json(200, {
        url: 'http://x/signed', name: FILE_ROW.name, bytes: PAYLOAD.length,
        sha256: SHA, expiresInSec: 900,
      });
    }
    if (u.pathname.startsWith('/v1/dl/')) {
      // Exactly what the real route does: 302 to R2 with the checksum in a
      // header, because the bytes never pass through the API.
      res.writeHead(302, {
        location: `http://127.0.0.1:${server.address().port}/signed-bytes`,
        'x-outcometick-sha256': SHA,
        'x-amz-meta-sha256': SHA,
        'cache-control': 'no-store',
      }).end();
      return undefined;
    }
    if (u.pathname === '/signed-bytes') {
      res.writeHead(200, { 'content-type': 'application/gzip' }).end(PAYLOAD);
      return undefined;
    }
    if (u.pathname === '/v1/public/coverage') return json(200, { venues: {} });
    if (u.pathname === '/v1/health') return json(200, { ok: true });
    return json(404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => new Promise((r) => server.close(r)),
  };
}

async function withApi(fn, overrides) {
  const api = await stubApi(overrides);
  try {
    return await fn(api, new DataClient({ key: 'ck_test', baseUrl: api.url }));
  } finally {
    await api.close();
  }
}

test('the key travels as a bearer header', async () => {
  await withApi(async (api, ot) => {
    await ot.meta();
    assert.equal(api.seen[0].auth, 'Bearer ck_test');
  });
});

test('the key is read from OT_KEY when not passed', () => {
  const prev = process.env.OT_KEY;
  try {
    process.env.OT_KEY = 'ck_from_env';
    assert.equal(new DataClient().key, 'ck_from_env');
  } finally {
    if (prev === undefined) delete process.env.OT_KEY; else process.env.OT_KEY = prev;
  }
});

test('a missing key fails with an explanation, not a 401', async () => {
  const prev = process.env.OT_KEY;
  try {
    delete process.env.OT_KEY;
    const ot = new DataClient({ baseUrl: 'http://127.0.0.1:1' });
    await assert.rejects(() => ot.meta(), /no API key[\s\S]*OT_KEY/);
  } finally {
    if (prev !== undefined) process.env.OT_KEY = prev;
  }
});

test('meta reports dimensions, and keeps the sentinel out of the value arrays', async () => {
  await withApi(async (_api, ot) => {
    const m = await ot.meta();
    assert.deepEqual(m.assets, ['BTCUSD', 'ETHUSD']);
    // A client that builds an enum from `intervals` must not meet a token.
    assert.ok(!m.intervals.includes(NO_VALUE));
    assert.equal(m.filterTokens.noValue, NO_VALUE);
    assert.deepEqual(m.filterTokens.appliesTo, ['interval']);
  });
});

test('array filters are sent as the comma alternatives the API expects', async () => {
  await withApi(async (api, ot) => {
    await ot.files({ asset: ['btc', 'eth'], interval: ['5m', NO_VALUE], dataset: 'prices' });
    const q = api.seen.at(-1).query;
    assert.equal(q.asset, 'btc,eth');
    assert.equal(q.interval, '5m,none');
    assert.equal(q.dataset, 'prices');
  });
});

test('empty and null filters are omitted rather than sent blank', async () => {
  await withApi(async (api, ot) => {
    await ot.files({ asset: [], dataset: null, venue: undefined, date: '2026-08-12' });
    const q = api.seen.at(-1).query;
    assert.deepEqual(Object.keys(q), ['date']);
  });
});

test('date together with from/to is refused before the round trip', async () => {
  await withApi(async (api, ot) => {
    await assert.rejects(
      () => ot.files({ date: '2026-08-12', from: '2026-08-01' }),
      /use either date, or from\/to — not both/,
    );
    // Refused locally: nothing reached the server.
    assert.equal(api.seen.length, 0);
  });
});

test('an API error keeps the status and the extra fields', async () => {
  await withApi(async (_api, ot) => {
    const err = await ot.files({ from: '2020-01-01', to: '2020-01-02' }).then(() => null, (e) => e);
    assert.ok(err instanceof OutcometickError);
    assert.equal(err.status, 403);
    // The useful half: not just "no", but what the window actually is.
    assert.equal(err.body.floor, '2026-07-14');
    assert.equal(err.body.ceiling, '2026-08-12');
    assert.match(err.message, /403/);
  }, {
    '/v1/files': (_req, _res, _u, json) => json(403, {
      error: 'from is outside your coverage', floor: '2026-07-14', ceiling: '2026-08-12',
    }),
  });
});

test('download follows the redirect manually and verifies the checksum', async () => {
  await withApi(async (api, ot) => {
    const { files } = await ot.files({ date: '2026-08-12' });
    const got = await ot.download(files[0]);
    assert.deepEqual(Buffer.from(got.bytes), PAYLOAD);
    assert.equal(got.sha256, SHA);
    // The redirect target was fetched WITHOUT our key: R2 has no use for it.
    const signed = api.seen.find((s) => s.path === '/signed-bytes');
    assert.equal(signed?.auth, undefined);
  });
});

test('download works from a bare date and name too', async () => {
  await withApi(async (_api, ot) => {
    const got = await ot.download('2026-08-12', FILE_ROW.name);
    assert.deepEqual(Buffer.from(got.bytes), PAYLOAD);
    // No row was supplied, so the checksum came from the 302's header.
    assert.equal(got.sha256, SHA);
  });
});

test('a corrupted download is rejected, not returned', async () => {
  await withApi(async (_api, ot) => {
    await assert.rejects(
      () => ot.download('2026-08-12', FILE_ROW.name),
      /checksum mismatch[\s\S]*expected[\s\S]*got/,
    );
  }, {
    '/signed-bytes': (_req, res) => {
      res.writeHead(200).end(Buffer.from('not the bytes you asked for'));
    },
  });
});

test('verify:false returns the bytes without checking them', async () => {
  await withApi(async (_api, ot) => {
    const got = await ot.download('2026-08-12', FILE_ROW.name, { verify: false });
    assert.equal(Buffer.from(got.bytes).toString(), 'not the bytes you asked for');
  }, {
    '/signed-bytes': (_req, res) => {
      res.writeHead(200).end(Buffer.from('not the bytes you asked for'));
    },
  });
});

test('saveTo writes the file to disk', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ot-dl-'));
  try {
    await withApi(async (_api, ot) => {
      const out = path.join(dir, 'x.csv.gz');
      await ot.download(FILE_ROW, { saveTo: out });
      assert.deepEqual(await readFile(out), PAYLOAD);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a download that 404s raises rather than writing an error page to disk', async () => {
  await withApi(async (_api, ot) => {
    const err = await ot.download('2026-08-12', 'nope.csv.gz').then(() => null, (e) => e);
    assert.ok(err instanceof OutcometickError);
    assert.equal(err.status, 404);
  }, {
    '/v1/dl/2026-08-12/nope.csv.gz': (_req, _res, _u, json) =>
      json(404, { error: 'file not found in your scope for that date' }),
  });
});

test('signUrl returns the short-lived url with its checksum', async () => {
  await withApi(async (api, ot) => {
    const s = await ot.signUrl('2026-08-12', FILE_ROW.name, { expiresIn: 300 });
    assert.equal(s.sha256, SHA);
    assert.equal(s.expiresInSec, 900);
    assert.equal(api.seen.at(-1).query.expiresIn, '300');
  });
});

test('days reports the window bounds', async () => {
  await withApi(async (_api, ot) => {
    const d = await ot.days();
    assert.deepEqual(d.days, ['2026-08-11', '2026-08-12']);
    assert.equal(d.floor, '2026-07-14');
    assert.equal(d.ceiling, null);
  });
});

test('the public endpoints do not send a key at all', async () => {
  const api = await stubApi();
  try {
    const ot = new DataClient({ key: null, baseUrl: api.url });
    await ot.coverage();
    await ot.health();
    assert.deepEqual(api.seen.map((s) => s.auth), [undefined, undefined]);
  } finally {
    await api.close();
  }
});

test('a trailing slash on baseUrl does not produce a doubled path', async () => {
  const api = await stubApi();
  try {
    const ot = new DataClient({ key: 'ck_test', baseUrl: `${api.url}/` });
    await ot.meta();
    assert.equal(api.seen[0].path, '/v1/meta');
  } finally {
    await api.close();
  }
});
