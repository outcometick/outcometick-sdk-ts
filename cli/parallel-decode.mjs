// spoolDay on several threads, for `ot run`: the same events files and the same
// answer as the sequential spool (runner/spool-day.mjs), byte for byte.
//
//  1. CHUNKS. This thread reads and gunzips each file of the day ONCE (zlib
//     runs on libuv's pool) and cuts it into ~4 MB chunks at line ends; each
//     chunk is handed, without a copy, to one of n parse threads in turn. A
//     parse thread splits a chunk into lines exactly as the sequential reader
//     does (readline: \r\n, \n or a lone \r ends a line; trimmed; blank lines
//     skipped; a CSV's header is its first non-blank line) and decodes each row.
//     Every event goes, tagged (file, chunk, line, position in the row), to that
//     thread's file for its market -- in order, since a thread's chunks arrive
//     in order. The book throttle is STATEFUL per market and order-dependent, so
//     it is not applied here: a row that consults it leaves a marker (position
//     -1) carrying what it asked.
//  2. MERGE. n threads each take a share of the markets and, one market at a
//     time, merge its n files in the sequential order (file, chunk, line,
//     position) while a fresh throttle made from the same spec replays the
//     markers, dropping what the sequential run dropped. So only what the
//     sequential spool keeps is ever held, one market per thread; each market is
//     finished by finishSpooledMarket, the sequential spool's own second half.
//
// Anything unusual -- a row that throws, a thread that dies or cannot start, a
// throttle that is not a fresh makeBookThrottle -- and the caller decodes the
// day sequentially instead, so a malformed archive fails exactly as it does
// without threads.

import { appendFileSync, createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

import { classifyPath } from '../api/lib/data-taxonomy.mjs';
import { eventsFromRow, makeBookThrottle, parseRow } from '../runner/events.mjs';
import { finishSpooledMarket, marketDayKey } from '../runner/spool-day.mjs';

const CHUNK_BYTES = 4 << 20;
const IN_FLIGHT_PER_THREAD = 2;
const BUFFER_BYTES = 16 << 20;
// readline's line ends: \r\n, \n, or a \r not followed by \n.
const LINE_END = /\r?\n|\r(?!\n)/;

// Measured on the sample day: ~0.45 GB on one thread, ~0.2 GB more per thread.
const BASE_BYTES = 0.5 * 2 ** 30;
const PER_THREAD_BYTES = 0.25 * 2 ** 30;

/**
 * How many threads `ot run` decodes on when not told: every core, unless that
 * would want more than half the machine's memory.
 */
export function defaultDecodeWorkers({ cores, totalBytes }) {
  const byMemory = Math.floor((totalBytes / 2 - BASE_BYTES) / PER_THREAD_BYTES);
  return Math.max(1, Math.min(cores, byMemory));
}

/** Can this day be decoded on threads at all? */
export function canSpoolInParallel({ workers, markets, throttle }) {
  if (!(workers > 1) || markets.size < 2) return false;
  // Phase 2 rebuilds the gate from its spec, so it must be one that has not
  // seen a row yet -- or none at all.
  return throttle == null || (throttle.spec != null && throttle.untouched === true);
}

class Fallback extends Error {}

/** For the tests: sees every thread started, and may make the next start fail. */
export const threadHooks = { beforeStart: null, started: null };

function startThread(data) {
  threadHooks.beforeStart?.(data);
  const w = new Worker(new URL(import.meta.url), { workerData: data });
  threadHooks.started?.(w);
  const done = new Promise((resolve, reject) => {
    let answer = null;
    w.on('message', (m) => { if (m.final) answer = m; });
    w.once('error', (err) => { answer = { fallback: err.message }; });
    w.once('exit', (code) => {
      if (code !== 0 || answer == null) reject(new Fallback(`decode thread exited ${code}`));
      else if (answer.fallback) reject(new Fallback(answer.fallback));
      else resolve(answer);
    });
  });
  done.catch(() => {});
  return { w, done };
}

/**
 * A file's bytes, gunzipped when it ends in .gz, as chunks of about
 * `chunkBytes` that each end at a line end (\n or \r; the last chunk may end
 * anywhere). A cut between the \r and \n of a \r\n only adds a blank line,
 * which is skipped like any other, and never splits a UTF-8 sequence.
 */
export async function* chunksOf(full, gz, chunkBytes) {
  const raw = createReadStream(full, { highWaterMark: 1 << 20 });
  const stream = gz ? raw.pipe(createGunzip({ chunkSize: 1 << 20 })) : raw;
  if (gz) raw.on('error', (err) => stream.destroy(err));
  let parts = [];
  let size = 0;
  let lastEnd = -1;  // offset, in parts, just past the last line end seen
  for await (const buf of stream) {
    const end = Math.max(buf.lastIndexOf(10), buf.lastIndexOf(13));
    if (end >= 0) lastEnd = size + end + 1;
    parts.push(buf);
    size += buf.length;
    if (size < chunkBytes || lastEnd < 0) continue;
    const all = Buffer.concat(parts, size);
    yield all.subarray(0, lastEnd);
    const rest = all.subarray(lastEnd);
    parts = rest.length ? [rest] : [];
    size = rest.length;
    lastEnd = -1;
  }
  if (size) yield Buffer.concat(parts, size);
}

/** An exclusively owned copy, so it can be transferred rather than cloned. */
function owned(buf) {
  const ab = new ArrayBuffer(buf.length);
  new Uint8Array(ab).set(buf);
  return ab;
}

/**
 * A CSV's header out of the chunk it is in: [header fields, the chunk after the
 * header line], or null when the chunk holds only blank lines.
 */
function takeHeader(buf) {
  let rest = buf.toString('utf8');
  for (;;) {
    const e = LINE_END.exec(rest);
    const s = (e ? rest.slice(0, e.index) : rest).trim();
    rest = e ? rest.slice(e.index + e[0].length) : '';
    if (s) return [s.split(','), Buffer.from(rest, 'utf8')];
    if (!e) return null;
  }
}

/**
 * spoolDay's answer ({ out, unusable, bboSeen, bytes }), decoded on `workers`
 * threads, or null when the caller should decode sequentially instead -- after
 * ANY failure here, so the sequential spool is what reports a bad archive.
 * `chunkBytes` is there for the tests, which cut tiny chunks.
 */
export async function spoolDayParallel({
  day, markets, bySlug, throttle = null, eventsDir, feedPaths, root, workers, chunkBytes = CHUNK_BYTES,
}) {
  if (!canSpoolInParallel({ workers, markets, throttle })) return null;
  const n = workers;
  const ids = [...markets.keys()];
  const indexOf = Object.fromEntries(ids.map((id, i) => [id, i]));
  const threads = [];
  // Every thread is in `threads` the moment it exists, so the finally below
  // ends it whatever happened; a thread that cannot be made is a fallback.
  const start = (data) => {
    const t = startThread(data);
    threads.push(t);
    return t;
  };
  const timing = process.env.OT_DECODE_TIMING ? Date.now() : null;
  let work = null;
  try {
    work = await mkdtemp(path.join(eventsDir, `.${day}-par-`));
    // Finished files land here first and move into eventsDir only once every
    // market is done: a day handed back to the sequential spool leaves nothing.
    const outDir = path.join(work, 'out');
    await mkdir(outDir);

    // Phase 1: one reader (here), n parse threads, at most two chunks queued each.
    const parse = [];
    for (let k = 0; k < n; k += 1) {
      parse.push(start({
        phase: 'parse', k, markets, bySlug, dir: work, indexOf,
        dataset: throttle?.dataset ?? null, gate: throttle != null,
      }));
    }
    const queued = parse.map(() => 0);
    const waiting = parse.map(() => []);
    let failed = null;
    for (const [k, t] of parse.entries()) {
      t.w.on('message', (m) => { if (m.ack) { queued[k] -= 1; waiting[k].shift()?.(); } });
      t.done.catch((err) => { failed ??= err; for (const q of waiting) while (q.length) q.shift()(); });
    }
    let next = 0;
    for (const [fi, rel] of feedPaths.entries()) {
      if (classifyPath(rel).dataset === 'markets') continue;
      const isCsv = rel.includes('.csv');
      let header = null;
      let ci = 0;
      for await (let buf of chunksOf(path.join(root, rel), rel.endsWith('.gz'), chunkBytes)) {
        if (failed) throw failed;
        if (isCsv && header === null) {
          const got = takeHeader(buf);
          if (!got) continue;
          [header, buf] = got;
          if (!buf.length) continue;
        }
        // Round-robin, so each thread sees its chunks in increasing order and
        // writes every market's records already sorted.
        const k = next % n;
        next += 1;
        if (queued[k] >= IN_FLIGHT_PER_THREAD) await new Promise((r) => waiting[k].push(r));
        if (failed) throw failed;
        queued[k] += 1;
        const ab = owned(buf);
        parse[k].w.postMessage({ fi, ci, rel, isCsv, header, ab }, [ab]);
        ci += 1;
      }
    }
    for (const t of parse) t.w.postMessage({ end: true });
    const stripes = await Promise.all(parse.map((t) => t.done));
    if (timing) process.stderr.write(`parse ${(Date.now() - timing) / 1000}s\n`);
    const bboSeen = new Set();
    for (const st of stripes) for (const key of st.bbo) bboSeen.add(key);

    // Phase 2: n threads, each finishing its share of markets one at a time.
    const finished = await Promise.all(Array.from({ length: Math.min(n, ids.length) }, (_, g) => start({
      phase: 'merge', n, day, outDir, dir: work, spec: throttle?.spec ?? null,
      markets: new Map(ids.filter((id) => indexOf[id] % n === g).map((id) => [id, markets.get(id)])),
      indexOf,
    }).done));
    if (timing) process.stderr.write(`merge ${(Date.now() - timing) / 1000}s\n`);
    const byId = new Map(finished.flatMap((r) => r.results));
    const out = [];
    const unusable = [];
    for (const id of ids) {
      const done = byId.get(id);
      if (done.unusable) unusable.push(done.unusable);
      else out.push(done.out);
    }
    for (const o of out) await rename(path.join(outDir, o.eventsFile), path.join(eventsDir, o.eventsFile));
    return { out, unusable, bboSeen, bytes: 0 };
  } catch (err) {
    if (timing) process.stderr.write(`threaded decode handed back: ${err.message}\n`);
    return null;
  } finally {
    await Promise.all(threads.map((t) => t.w.terminate()));
    if (work) await rm(work, { recursive: true, force: true });
  }
}

// --- inside a thread --------------------------------------------------------

function parseThread({ k, markets, bySlug, dir, indexOf, dataset, gate }) {
  // One file per market, appended in budget-sized batches: the thread never
  // holds more than BUFFER_BYTES of records, however dense the day.
  const bufs = new Map();
  let held = 0;
  const flush = () => {
    for (const [i, buf] of bufs) appendFileSync(path.join(dir, `s${k}-m${i}`), buf.join(''));
    bufs.clear();
    held = 0;
  };
  const put = (key, line) => {
    const i = indexOf[key];
    let buf = bufs.get(i);
    if (!buf) { buf = []; bufs.set(i, buf); }
    buf.push(line);
    held += line.length;
    if (held >= BUFFER_BYTES) flush();
  };
  const bbo = new Set();
  let asked = [];
  // Keeps everything and remembers who asked; the real gate decides in phase 2.
  const probe = gate ? { keep(ds, marketId, ts, asset) { if (ds === dataset) asked.push([marketId, ts, asset, ds]); return true; } } : null;
  const finish = (answer) => {
    if (!answer.fallback) flush();
    parentPort.postMessage({ final: true, ...answer });
    parentPort.close();
  };
  parentPort.on('message', (msg) => {
    if (msg.end) { finish({ bbo: [...bbo] }); return; }
    const { fi, ci, rel, isCsv, header, ab } = msg;
    const lines = Buffer.from(ab).toString('utf8').split(LINE_END);
    for (const [li, line] of lines.entries()) {
      const s = line.trim();
      if (!s) continue;
      const row = parseRow(s, { isCsv, header });
      if (!row) continue;
      asked = [];
      let evs;
      try {
        evs = eventsFromRow(rel, row, markets, bySlug, probe);
      } catch (err) {
        finish({ fallback: `${rel}: ${err.message}` });
        return;
      }
      const at = `${fi} ${ci} ${li}`;
      for (const [mid, ts, asset, ds] of asked) {
        const key = String(mid);
        if (markets.has(key)) put(key, `${at} -1\t${JSON.stringify([ts, asset, ds])}\n`);
      }
      for (const [j, [mid, ev]] of evs.entries()) {
        if (ev.bbo) {
          // A row the gate could drop never carries a bound (it thins only the
          // delta/snapshot stream); if one ever did, its bound would be counted
          // here regardless, so hand the day back.
          if (asked.length) { finish({ fallback: 'a thinned row carried a top-of-book bound' }); return; }
          bbo.add(marketDayKey(markets.get(mid)));
        }
        const key = String(mid);
        if (markets.has(key)) put(key, `${at} ${j}\t${JSON.stringify(ev)}\n`);
      }
    }
    parentPort.postMessage({ ack: true });
  });
}

/** One parse thread's records for one market, in order: [[file, chunk, line, j], payload]. */
async function* recordsOf(file) {
  let input;
  try {
    input = createReadStream(file);
    await new Promise((resolve, reject) => { input.once('open', resolve); input.once('error', reject); });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  // Payloads are JSON.stringify output: no raw \r or \n inside a record.
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    yield [line.slice(0, tab).split(' ').map(Number), line.slice(tab + 1)];
  }
}

const before = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]) || (a[3] - b[3]);

async function mergeThread({ n, day, outDir, dir, spec, markets, indexOf }) {
  const results = [];
  for (const [marketId, market] of markets) {
    // An n-way merge of already sorted files, thinned as it goes: only what
    // the sequential spool would have kept is ever held, one market at a time.
    const gate = spec ? makeBookThrottle(spec) : null;
    const its = [];
    const heads = [];
    for (let k = 0; k < n; k += 1) {
      const it = recordsOf(path.join(dir, `s${k}-m${indexOf[marketId]}`));
      const first = await it.next();
      if (!first.done) { its.push(it); heads.push(first.value); }
    }
    const events = [];
    let dropped = null;
    while (heads.length) {
      let m = 0;
      for (let i = 1; i < heads.length; i += 1) if (before(heads[i][0], heads[m][0]) < 0) m = i;
      const [[fi, ci, li, j], payload] = heads[m];
      const nxt = await its[m].next();
      if (nxt.done) { heads.splice(m, 1); its.splice(m, 1); } else heads[m] = nxt.value;
      const row = `${fi} ${ci} ${li}`;
      if (j === -1) {
        const [ts, asset, ds] = JSON.parse(payload);
        dropped = gate.keep(ds, marketId, ts, asset) ? null : row;
        continue;
      }
      if (dropped === row) continue;
      // The sequential spool writes JSON.stringify(event) and parses it back;
      // this is that line.
      events.push(JSON.parse(payload));
    }
    results.push([marketId, await finishSpooledMarket({ day, marketId, market, events, eventsDir: outDir })]);
  }
  parentPort.postMessage({ final: true, results });
}

if (!isMainThread && workerData?.phase === 'parse') parseThread(workerData);
if (!isMainThread && workerData?.phase === 'merge') {
  mergeThread(workerData).catch((err) => parentPort.postMessage({ final: true, fallback: err.message }));
}
