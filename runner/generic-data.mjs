// Decode user-supplied binary Polymarket markets and CLOB frames into replay
// events. Archive decoding remains separate; engine differences are selected
// by market.kind === 'generic'.
//
// Events sort by (time, input sequence), preserving recorded ties across markets.
// Unreadable book rows or unknown tokens make the entire market unusable.
// Trading ends at the earliest of the declared end, the millisecond before
// public resolution, or the last event. Resolved markets pay at resolution;
// unresolved markets use marks from external data, independent of strategy fills.
//
// Keep in sync with client/backtest/generic.py. The equivalence suite compares
// events and market records.

import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import path from 'node:path';

import { Book, toTicks } from './engine/book.mjs';
import { OUTCOMES, FEE_MODEL_PM } from './engine/portfolio.mjs';
import { feeOf } from './events.mjs';

export const GENERIC_KIND = 'generic';

/** Plausible epoch milliseconds: 2000-01-01 .. 2100-01-01. */
const TS_MIN = 946_684_800_000;
const TS_MAX = 4_102_444_800_000;

/** Events per in-memory sort run; a market larger than this is merge-sorted. */
export const SORT_RUN = 200_000;
/** Open run files per merge pass. */
export const MERGE_FANIN = 64;
/** Event lines buffered per market before they are appended to its spool. */
const SPOOL_FLUSH = 512;

/** Dataset-level read error for local decoding. */
export class DatasetError extends Error {}

/** Integer epoch milliseconds (number, or a string of digits), or null. */
export function parseTimeMs(v) {
  let n = null;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^[0-9]+$/.test(v)) n = Number(v);
  if (n == null || !Number.isInteger(n) || n < TS_MIN || n >= TS_MAX) return null;
  return n;
}

/**
 * Parse a zoned ISO-like date-time to epoch milliseconds, or null.
 * Accept Gamma forms such as 2025-01-01T12:00:00Z and 2025-01-01 12:00:00+00.
 * Parse explicitly for Python parity; reject times without a zone.
 */
export function parseIsoMs(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(v.trim());
  if (!m) return null;
  const [, Y, Mo, D, h, mi, s, frac, zone] = m;
  const y = Number(Y); const mo = Number(Mo); const d = Number(D);
  const hh = Number(h); const mm = Number(mi); const ss = Number(s);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59 || ss > 59) return null;
  let ms = Date.UTC(y, mo - 1, d, hh, mm, ss);
  // Date.UTC rolls 31 February into March; a real date round-trips.
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  if (frac) ms += Number(frac.slice(0, 3).padEnd(3, '0'));
  if (zone !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    const oh = Number(digits.slice(0, 2));
    const om = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
    if (oh > 23 || om > 59) return null;
    ms -= sign * (oh * 60 + om) * 60_000;
  }
  return parseTimeMs(ms);
}

/** A JSON list given either as a list or as Gamma's JSON-encoded string. */
function jsonList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try {
      const out = JSON.parse(v);
      return Array.isArray(out) ? out : null;
    } catch { return null; }
  }
  return null;
}

/** A price field as a number: a finite JSON number or a plain decimal string. */
function priceNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^-?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(v.trim())) {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Read UP, DOWN or TIE from settled pairs 1/0, 0/1 or 0.5/0.5.
 * Other prices, including 0.9995, are not resolution evidence.
 */
function outcomeOfPair(v) {
  const p = jsonList(v);
  if (!p || p.length !== 2) return null;
  const val = (x) => {
    if (typeof x === 'number' && Number.isFinite(x)) return x;
    if (typeof x === 'string' && ['0', '1', '0.5'].includes(x.trim())) return Number(x.trim());
    return null;
  };
  const a = val(p[0]);
  const b = val(p[1]);
  if (a === 1 && b === 0) return 'UP';
  if (a === 0 && b === 1) return 'DOWN';
  if (a === 0.5 && b === 0.5) return 'TIE';
  return null;
}

const isGamma = (e) => Object.prototype.hasOwnProperty.call(e, 'clobTokenIds')
  || Object.prototype.hasOwnProperty.call(e, 'conditionId');

/**
 * Normalise a markets entry, or return {why}. Accept a generic record,
 * a Gamma object, or a record with a nested gamma object. Explicit identity
 * fields take precedence; resolution evidence from both sources must agree.
 */
export function genericRecord(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { id: null, why: 'entry is not an object' };
  const gammaOnly = isGamma(entry);
  const g = gammaOnly ? entry : (entry.gamma && typeof entry.gamma === 'object' && !Array.isArray(entry.gamma) ? entry.gamma : null);
  const own = gammaOnly ? {} : entry;
  const has = (k) => Object.prototype.hasOwnProperty.call(own, k);

  const id = own.market_id ?? own.condition_id ?? g?.conditionId ?? null;
  if (typeof id !== 'string' || id === '') return { id: null, why: 'no market id (market_id / conditionId as a string)' };
  const reject = (why) => ({ id, why });

  const tokens = has('token_ids') ? own.token_ids : jsonList(g?.clobTokenIds);
  if (!Array.isArray(tokens) || tokens.length !== 2
    || !tokens.every((t) => typeof t === 'string' && t !== '') || tokens[0] === tokens[1]) {
    return reject('token_ids must be two distinct non-empty strings (a number token id has already lost digits)');
  }
  const labels = has('labels') ? own.labels : jsonList(g?.outcomes);
  if (!Array.isArray(labels) || labels.length !== 2
    || !labels.every((l) => typeof l === 'string' && l.trim() !== '')) {
    return reject('labels must be two non-empty strings (or Gamma outcomes)');
  }
  const low = labels.map((l) => l.trim().toLowerCase());
  if (low[0] === low[1]) return reject('labels must differ (case-insensitively)');
  if (low[1] === 'up' || low[0] === 'down') return reject('a label named Up/Down must sit at that index (0 = Up, 1 = Down)');

  const optTime = (k) => {
    if (!has(k) || own[k] == null) return { ok: true, v: null };
    const v = parseTimeMs(own[k]);
    return v == null ? { ok: false } : { ok: true, v };
  };
  const tradingEnd = optTime('trading_end_ts_ms');
  if (!tradingEnd.ok) return reject('trading_end_ts_ms must be integer epoch milliseconds');
  const start = optTime('start_ts_ms');
  if (!start.ok) return reject('start_ts_ms must be integer epoch milliseconds');

  let fee = null;
  if (has('fee')) {
    const f = own.fee;
    if (f == null) fee = null;
    else if (typeof f === 'object' && f.model === 'none') fee = { model: 'none' };
    else if (typeof f === 'object' && f.model === FEE_MODEL_PM && typeof f.rate === 'number'
      && Number.isFinite(f.rate) && f.rate >= 0 && f.rate <= 1) fee = { model: FEE_MODEL_PM, rate: f.rate };
    else return reject(`fee must be null, {model:"none"} or {model:"${FEE_MODEL_PM}", rate}`);
  } else if (g) {
    fee = feeOf({ raw: g });
  }

  const evidence = [];
  if (has('resolution') && own.resolution != null) {
    const r = own.resolution;
    const ts = parseTimeMs(r?.resolved_ts_ms);
    if (typeof r !== 'object' || !OUTCOMES.includes(r.outcome) || ts == null) {
      return reject('resolution must be {outcome: "UP"|"DOWN"|"TIE", resolved_ts_ms}');
    }
    evidence.push({ outcome: r.outcome, ts, source: 'explicit' });
  }
  if (g && g.umaResolutionStatus === 'resolved') {
    const outcome = outcomeOfPair(g.outcomePrices);
    if (outcome == null) return reject('Gamma says resolved but outcomePrices is not exactly 1/0, 0/1 or 0.5/0.5');
    const ts = parseIsoMs(g.umaEndDate) ?? parseIsoMs(g.closedTime);
    evidence.push({ outcome, ts, source: 'gamma' });
  }

  const str = (v) => (typeof v === 'string' && v !== '' ? v : null);
  return {
    id,
    record: {
      kind: GENERIC_KIND,
      venue: 'polymarket',
      market_id: id,
      slug: str(has('slug') ? own.slug : g?.slug),
      question: str(has('question') ? own.question : g?.question),
      token_ids: [tokens[0], tokens[1]],
      labels: [labels[0], labels[1]],
      fee,
      tick_size: priceNum(has('tick_size') ? own.tick_size : g?.orderPriceMinTickSize),
      min_size: priceNum(has('min_size') ? own.min_size : g?.orderMinSize),
      trading_end_ts_ms: tradingEnd.v,
      start_ts_ms: start.v,
      asset: null,
      interval: null,
      strike: null,
      evidence,
    },
  };
}

/** The markets file's entries -> records, with dataset-level uniqueness enforced. */
export function indexGenericMarkets(entries) {
  if (!Array.isArray(entries)) throw new DatasetError('the markets file must hold a list of markets');
  const markets = new Map();
  const rejected = [];
  const bySlug = new Map();
  const byToken = new Map();
  for (const entry of entries) {
    const r = genericRecord(entry);
    if (r.why) { rejected.push({ market_id: r.id, why: r.why }); continue; }
    const rec = r.record;
    if (markets.has(rec.market_id)) throw new DatasetError(`market ${rec.market_id} appears twice in the markets file`);
    if (rec.slug != null) {
      if (bySlug.has(rec.slug)) throw new DatasetError(`slug ${rec.slug} names two markets`);
      bySlug.set(rec.slug, rec.market_id);
    }
    for (const t of rec.token_ids) {
      if (byToken.has(t)) throw new DatasetError(`token ${t} belongs to two markets`);
      byToken.set(t, rec.market_id);
    }
    markets.set(rec.market_id, rec);
  }
  return { markets, rejected, bySlug, byToken };
}

/**
 * Strict ladder: `[{price,size}]` or `[[price,size]]` -> `[[px,size]]` with
 * zero sizes dropped, or null when any level is unreadable or two levels share
 * a (quantised) price.
 */
function strictLadder(levels) {
  if (!Array.isArray(levels)) return null;
  const out = [];
  const seen = new Set();
  for (const lv of levels) {
    const px = priceNum(Array.isArray(lv) ? lv[0] : lv?.price);
    const size = priceNum(Array.isArray(lv) ? lv[1] : lv?.size);
    if (px == null || size == null || px < 0 || px > 1 || size < 0) return null;
    const t = toTicks(px);
    if (seen.has(t)) return null;
    seen.add(t);
    if (size > 0) out.push([px, size]);
  }
  return out;
}

const SIDE_OF = (rec, token) => {
  const i = rec.token_ids.indexOf(token);
  return i === 0 ? 'UP' : (i === 1 ? 'DOWN' : null);
};

const BOOK_TYPES = new Set(['book', 'price_change', 'best_bid_ask']);

/**
 * Routes frames to markets and turns them into events.
 *
 * Stateful across the whole dataset: the input sequence number is global, so
 * session mode can keep a same-millisecond A->B->A order across markets.
 */
export class FrameRouter {
  constructor({ markets, bySlug, byToken }) {
    this.markets = markets;
    this.bySlug = bySlug;
    this.byToken = byToken;
    this.seq = 0;
    /** market_id -> routing state */
    this.state = new Map();
    for (const id of markets.keys()) {
      this.state.set(id, { bad: null, n: 0, first: null, last: null, resolution: null, buf: [] });
    }
    this.counts = {
      frames: 0,
      bad_json: 0,
      not_an_object: 0,
      unattributed: 0,
      bad_trade_rows: 0,
      ignored: {},
    };
  }

  #bad(id, why, at) {
    const st = this.state.get(id);
    if (st && !st.bad) st.bad = { why, at };
  }

  /** One line of a frames file. `at` names it in error messages. */
  line(text, at) {
    let obj;
    try { obj = JSON.parse(text); } catch { this.counts.bad_json += 1; return; }
    this.frame(obj, at);
  }

  frame(obj, at) {
    if (Array.isArray(obj)) { for (const x of obj) this.frame(x, at); return; }
    this.counts.frames += 1;
    if (!obj || typeof obj !== 'object') { this.counts.not_an_object += 1; return; }
    const payload = obj.payload && typeof obj.payload === 'object' && !Array.isArray(obj.payload) ? obj.payload : obj;
    const type = obj.event_type ?? payload.event_type;

    // Require all supplied market identifiers to agree and be recognised.
    const ids = [];
    let unknown = false;
    const name = (v, lookup) => {
      if (v == null) return;
      const id = lookup(String(v));
      if (id == null) unknown = true;
      else ids.push(id);
    };
    name(obj.market_id, (v) => (this.markets.has(v) ? v : null));
    name(obj.slug, (v) => this.bySlug.get(v) ?? null);
    name(payload.market, (v) => (this.markets.has(v) ? v : null));
    const tokens = [];
    if (type === 'price_change') {
      const changes = Array.isArray(payload.price_changes) ? payload.price_changes : [];
      for (const ch of changes) tokens.push(ch?.asset_id);
    } else {
      const a = obj.asset_id ?? payload.asset_id;
      if (a != null) tokens.push(a);
    }
    if (ids.length === 0 && !unknown) {
      for (const t of tokens) if (typeof t === 'string' && this.byToken.has(t)) ids.push(this.byToken.get(t));
    }
    const distinct = [...new Set(ids)];
    if (distinct.length === 0) { this.counts.unattributed += 1; return; }
    if (distinct.length > 1 || unknown) {
      for (const id of distinct) this.#bad(id, 'frame names conflicting markets', at);
      return;
    }
    const id = distinct[0];
    const rec = this.markets.get(id);
    const st = this.state.get(id);

    if (!BOOK_TYPES.has(type) && type !== 'last_trade_price' && type !== 'market_resolved') {
      const k = typeof type === 'string' ? type : '(not a string)';
      this.counts.ignored[k] = (this.counts.ignored[k] ?? 0) + 1;
      return;
    }
    const tsRaw = obj.event_ts_ms !== undefined ? obj.event_ts_ms : payload.timestamp;
    const ts = parseTimeMs(tsRaw);
    const recv = parseTimeMs(obj.recv_ms ?? obj.recv_ts_ms ?? null);
    const isBook = BOOK_TYPES.has(type);
    if (ts == null) {
      if (isBook) this.#bad(id, `${type} row without a readable timestamp`, at);
      else if (type === 'market_resolved') this.#bad(id, 'market_resolved without a readable timestamp', at);
      else this.counts.bad_trade_rows += 1;
      return;
    }
    if (st.bad) return;

    if (type === 'market_resolved') {
      let outcome = null;
      const win = payload.winning_asset_id;
      if (typeof win === 'string') {
        const side = SIDE_OF(rec, win);
        outcome = side;
      } else if (typeof payload.winning_outcome === 'string') {
        const w = payload.winning_outcome.trim().toLowerCase();
        const i = rec.labels.findIndex((l) => l.trim().toLowerCase() === w);
        outcome = i === 0 ? 'UP' : (i === 1 ? 'DOWN' : null);
      }
      if (outcome == null) { this.#bad(id, 'market_resolved names no outcome of this market', at); return; }
      const r = st.resolution;
      if (r && r.outcome !== outcome) { this.#bad(id, 'market_resolved frames disagree on the outcome', at); return; }
      if (!r || ts < r.ts) st.resolution = { outcome, ts, source: 'frame' };
      return;
    }

    const tokenSide = (t) => (typeof t === 'string' ? SIDE_OF(rec, t) : null);
    const extra = (ev) => {
      ev.seq = this.seq;
      this.seq += 1;
      ev.recv_ts_ms = recv;
      return ev;
    };
    const out = [];
    if (type === 'book') {
      const side = tokenSide(obj.asset_id ?? payload.asset_id);
      if (!side) { this.#bad(id, 'book row for a token this market does not own', at); return; }
      const asks = strictLadder(payload.asks ?? payload.sells);
      const bids = strictLadder(payload.bids ?? payload.buys);
      if (!asks || !bids) { this.#bad(id, 'book row with an unreadable or duplicated level', at); return; }
      out.push(extra({ kind: 'book', ts_ms: ts, snapshot: true, side, levels: { [side]: { asks, bids } } }));
    } else if (type === 'price_change') {
      const changes = payload.price_changes;
      if (!Array.isArray(changes) || changes.length === 0) { this.#bad(id, 'price_change without price_changes', at); return; }
      for (const ch of changes) {
        const side = tokenSide(ch?.asset_id);
        const px = priceNum(ch?.price);
        const size = priceNum(ch?.size);
        const s = typeof ch?.side === 'string' ? ch.side.toUpperCase() : null;
        if (!side || px == null || size == null || px < 0 || px > 1 || size < 0 || (s !== 'BUY' && s !== 'SELL')) {
          this.#bad(id, 'price_change entry with an unknown token, side, price or size', at);
          return;
        }
        out.push({ kind: 'book', ts_ms: ts, snapshot: false, side, ladder: s === 'SELL' ? 'asks' : 'bids', px, size });
      }
      for (const ev of out) extra(ev);
    } else if (type === 'best_bid_ask') {
      const side = tokenSide(obj.asset_id ?? payload.asset_id);
      const bid = priceNum(payload.best_bid);
      const ask = priceNum(payload.best_ask);
      if (!side || bid == null || ask == null || bid < 0 || bid > 1 || ask < 0 || ask > 1 || bid > ask) {
        this.#bad(id, 'best_bid_ask row with an unknown token or an unreadable / crossed bound', at);
        return;
      }
      out.push(extra({ kind: 'book', ts_ms: ts, snapshot: false, bbo: true, side, bid, ask }));
    } else {
      const side = tokenSide(obj.asset_id ?? payload.asset_id);
      const px = priceNum(payload.price);
      const size = priceNum(payload.size);
      const s = typeof payload.side === 'string' ? payload.side.toUpperCase() : null;
      if (!side || px == null || size == null || px < 0 || px > 1 || !(size > 0) || (s !== 'BUY' && s !== 'SELL')) {
        this.counts.bad_trade_rows += 1;
        return;
      }
      out.push(extra({ kind: 'trade', ts_ms: ts, market_id: id, px, size, side, taker: s }));
    }
    for (const ev of out) this.#push(id, st, ev);
  }

  /** Internal events (the pmdata adapter), routed like decoded frames. */
  events(id, list) {
    const st = this.state.get(id);
    if (!st || st.bad) return;
    for (const ev of list) {
      ev.seq = this.seq;
      this.seq += 1;
      if (!('recv_ts_ms' in ev)) ev.recv_ts_ms = null;
      this.#push(id, st, ev);
    }
  }

  resolve(id, evidence) {
    const st = this.state.get(id);
    if (!st || st.bad) return;
    const r = st.resolution;
    if (r && r.outcome !== evidence.outcome) { this.#bad(id, 'resolution frames disagree on the outcome', null); return; }
    if (!r || evidence.ts < r.ts) st.resolution = { ...evidence };
  }

  #push(id, st, ev) {
    st.n += 1;
    if (st.first == null || ev.ts_ms < st.first) st.first = ev.ts_ms;
    if (st.last == null || ev.ts_ms > st.last) st.last = ev.ts_ms;
    st.buf.push(JSON.stringify(ev));
  }

  /** Return and clear buffered lines for id. */
  take(id) {
    const st = this.state.get(id);
    const out = st.buf;
    st.buf = [];
    return out;
  }

  pending(id) { return this.state.get(id).buf.length; }
}

/** Frame files of a dataset directory, in byte order of their relative path. */
export async function datasetFiles(root) {
  const out = [];
  const walk = async (dir, rel) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), r);
      else if (e.isFile() && /\.jsonl(\.gz)?$/.test(e.name) && r !== 'markets.jsonl') out.push(r);
    }
  };
  await walk(root, '');
  return out.sort((a, b) => (a < b ? -1 : (a > b ? 1 : 0)));
}

/** `markets.json` / `markets.jsonl` at the top of `root`: which one, or null. */
export async function marketsFileOf(root) {
  const found = [];
  for (const name of ['markets.json', 'markets.jsonl']) {
    try {
      if ((await stat(path.join(root, name))).isFile()) found.push(name);
    } catch { /* absent */ }
  }
  if (found.length > 1) throw new DatasetError(`${root} holds both markets.json and markets.jsonl — keep one`);
  return found[0] ?? null;
}

/** Is `root` a generic dataset (a markets file at its top)? */
export async function looksLikeGenericDataset(root) {
  try {
    if (!(await stat(root)).isDirectory()) return false;
    return (await marketsFileOf(root)) != null;
  } catch (err) {
    if (err instanceof DatasetError) throw err;
    return false;
  }
}

export async function* fileLines(file) {
  const raw = createReadStream(file);
  let input = raw;
  if (file.endsWith('.gz')) {
    const gunzip = createGunzip();
    input = gunzip;
    pipeline(raw, gunzip).catch((err) => { if (!gunzip.destroyed) gunzip.destroy(err); });
  }
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (t) yield t;
  }
}

export async function readMarketsFile(root) {
  const name = await marketsFileOf(root);
  if (!name) throw new DatasetError(`${root} has no markets.json or markets.jsonl`);
  const file = path.join(root, name);
  if (name === 'markets.json') {
    const { readFile } = await import('node:fs/promises');
    let v;
    try { v = JSON.parse(await readFile(file, 'utf8')); } catch (err) {
      throw new DatasetError(`markets.json is not valid JSON: ${err.message}`);
    }
    return v;
  }
  const out = [];
  let i = 0;
  for await (const line of fileLines(file)) {
    i += 1;
    try { out.push(JSON.parse(line)); } catch {
      throw new DatasetError(`markets.jsonl line ${i} is not valid JSON`);
    }
  }
  return out;
}

// Sort a market's spooled events by (ts, seq) in bounded memory.

const cmpEv = (a, b) => (a.ts_ms - b.ts_ms) || (a.seq - b.seq);

async function* parsedLines(file) {
  for await (const line of fileLines(file)) yield JSON.parse(line);
}

class EvHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  static less(x, y) { return cmpEv(x.ev, y.ev) < 0; }
  push(c) {
    const a = this.a; a.push(c);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (!EvHeap.less(a[i], a[p])) break; [a[i], a[p]] = [a[p], a[i]]; i = p; }
  }
  pop() {
    const a = this.a; const top = a[0]; const last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1; const r = l + 1; let s = i;
        if (l < a.length && EvHeap.less(a[l], a[s])) s = l;
        if (r < a.length && EvHeap.less(a[r], a[s])) s = r;
        if (s === i) break; [a[i], a[s]] = [a[s], a[i]]; i = s;
      }
    }
    return top;
  }
}

async function* mergeRuns(files) {
  const heap = new EvHeap();
  for (const f of files) {
    const it = parsedLines(f)[Symbol.asyncIterator]();
    const first = await it.next();
    if (!first.done) heap.push({ ev: first.value, it });
  }
  while (heap.size) {
    const c = heap.pop();
    yield c.ev;
    const nx = await c.it.next();
    if (!nx.done) { c.ev = nx.value; heap.push(c); }
  }
}

/**
 * Sort one market by (ts, seq), holding at most SORT_RUN events per run.
 * Larger markets use sorted scratch runs merged MERGE_FANIN files at a time.
 */
export async function* sortedEvents(file, count, { runSize = SORT_RUN, fanIn = MERGE_FANIN } = {}) {
  if (count <= runSize) {
    const all = [];
    for await (const ev of parsedLines(file)) all.push(ev);
    all.sort(cmpEv);
    yield* all;
    return;
  }
  const dir = `${file}.runs`;
  await mkdir(dir, { recursive: true });
  try {
    let runs = [];
    let chunk = [];
    const flush = async () => {
      chunk.sort(cmpEv);
      const f = path.join(dir, `r${runs.length}.jsonl`);
      await writeFile(f, `${chunk.map((e) => JSON.stringify(e)).join('\n')}\n`);
      runs.push(f);
      chunk = [];
    };
    for await (const ev of parsedLines(file)) {
      chunk.push(ev);
      if (chunk.length >= runSize) await flush();
    }
    if (chunk.length) await flush();
    let pass = 0;
    while (runs.length > fanIn) {
      const next = [];
      for (let i = 0; i < runs.length; i += fanIn) {
        const group = runs.slice(i, i + fanIn);
        const f = path.join(dir, `p${pass}-${next.length}.jsonl`);
        const lines = [];
        const { open } = await import('node:fs/promises');
        const fh = await open(f, 'w');
        try {
          for await (const ev of mergeRuns(group)) {
            lines.push(JSON.stringify(ev));
            if (lines.length >= 4096) { await fh.write(`${lines.join('\n')}\n`); lines.length = 0; }
          }
          if (lines.length) await fh.write(`${lines.join('\n')}\n`);
        } finally { await fh.close(); }
        for (const g of group) await rm(g, { force: true });
        next.push(f);
      }
      runs = next;
      pass += 1;
    }
    yield* mergeRuns(runs);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Valuation from external market data, independent of simulated fills.

/**
 * Track external best bids, asks and quote times in input order.
 * BBO states both prices; snapshots replace the token's book. Deltas refresh
 * the quote only at or better than the current best, using the new book top.
 * Deeper changes leave quote times unchanged. Quote age uses the older side
 * to avoid treating a stale price as current.
 */
export class QuoteState {
  constructor() {
    this.book = new Book();
    this.quote = { UP: { bid: null, ask: null }, DOWN: { bid: null, ask: null } };
    // The last public print, in input order, as an UP price.
    this.lastTrade = null;
  }

  #restate(side, ladder, ts) {
    const top = this.book.ladders[side][ladder].levels[0];
    this.quote[side][ladder === 'bids' ? 'bid' : 'ask'] = top ? { px: top.ticks / 10_000, ts } : null;
  }

  #touch(side, ladder, px, ts) {
    const cur = this.quote[side][ladder === 'bids' ? 'bid' : 'ask'];
    const t = toTicks(px);
    if (cur == null || (ladder === 'bids' ? t >= toTicks(cur.px) : t <= toTicks(cur.px))) this.#restate(side, ladder, ts);
  }

  apply(ev) {
    if (ev.kind === 'trade') {
      this.lastTrade = { up: ev.side === 'UP' ? ev.px : 1 - ev.px, at: ev.ts_ms };
      return;
    }
    if (ev.kind !== 'book') return;
    applyBookEvent(this.book, ev, true);
    const ts = ev.ts_ms;
    if (ev.bbo) {
      this.quote[ev.side] = { bid: { px: ev.bid, ts }, ask: { px: ev.ask, ts } };
    } else if (ev.snapshot) {
      for (const side of ['UP', 'DOWN']) {
        if (ev.levels?.[side] == null) continue;
        this.#restate(side, 'bids', ts);
        this.#restate(side, 'asks', ts);
      }
    } else if (ev.side && ev.ladder) {
      this.#touch(ev.side, ev.ladder, ev.px, ts);
      if (ev.mirror === true) {
        const m = Number((1 - ev.px).toFixed(10));
        if (m >= 0 && m <= 1) this.#touch(ev.side === 'UP' ? 'DOWN' : 'UP', ev.ladder === 'asks' ? 'bids' : 'asks', m, ts);
      }
    }
  }

  /** {bid:{px,ts}|null, ask:{px,ts}|null} for one token; the venue writes "none" as 0 / 1. */
  top(side) {
    let { bid, ask } = this.quote[side];
    if (bid && !(bid.px > 0)) bid = null;
    if (ask && !(ask.px < 1)) ask = null;
    return { bid: bid ? { ...bid } : null, ask: ask ? { ...ask } : null };
  }

  /**
   * The mark at `ts`: UP mid -> 1 - DOWN mid -> last public trade, each
   * candidate checked for freshness before moving on. Returns
   * `{ up, source, ts_ms, age_ms }` or `{ none: 'no_quote' | 'stale' }`.
   */
  mark(ts, maxAgeMs = null) {
    const cands = [];
    for (const side of ['UP', 'DOWN']) {
      const { bid, ask } = this.top(side);
      if (bid && ask && bid.px < ask.px) {
        const mid = (bid.px + ask.px) / 2;
        cands.push({ up: side === 'UP' ? mid : 1 - mid, source: side === 'UP' ? 'up_mid' : 'down_mid', at: Math.min(bid.ts, ask.ts) });
      }
    }
    if (this.lastTrade) cands.push({ up: this.lastTrade.up, source: 'last_trade', at: this.lastTrade.at });
    if (!cands.length) return { none: 'no_quote' };
    for (const c of cands) {
      const age = ts - c.at;
      if (maxAgeMs == null || age <= maxAgeMs) return { up: c.up, source: c.source, ts_ms: c.at, age_ms: age };
    }
    return { none: 'stale' };
  }
}

/** One book event against a Book, generic rules (inclusive bounds, mirrored deltas). */
export function applyBookEvent(book, ev, generic) {
  if (ev.bbo) book.bbo(ev.ts_ms, ev.side, ev.bid, ev.ask, generic ? { inclusive: true } : undefined);
  else if (ev.snapshot) book.snapshot(ev.ts_ms, ev.levels);
  else if (ev.side && ev.ladder) {
    if (ev.mirror) book.deltaMirrored(ev.ts_ms, ev.side, ev.ladder, ev.px, ev.size);
    else book.delta(ev.ts_ms, ev.side, ev.ladder, ev.px, ev.size);
  }
}

/** The full two-token state of a Book as snapshot levels. */
function bookLevels(book) {
  const out = {};
  for (const side of ['UP', 'DOWN']) {
    out[side] = {
      asks: book.ladders[side].asks.levels.map((l) => [l.ticks / 10_000, l.size]),
      bids: book.ladders[side].bids.levels.map((l) => [l.ticks / 10_000, l.size]),
    };
  }
  return out;
}

/**
 * The resolution of a market from every piece of evidence, or a rejection.
 * Sources must agree on the outcome; the time is the frame's (observed), else
 * the explicit record's, else Gamma's.
 */
export function resolutionOf(rec, frame) {
  const ev = [...rec.evidence, ...(frame ? [frame] : [])];
  if (!ev.length) return { resolution: null };
  const outcomes = new Set(ev.map((e) => e.outcome));
  if (outcomes.size > 1) {
    return { why: `resolution sources disagree: ${ev.map((e) => `${e.source}=${e.outcome}`).join(', ')}` };
  }
  const pick = (src) => ev.find((e) => e.source === src && e.ts != null);
  const chosen = pick('frame') ?? pick('explicit') ?? pick('gamma');
  if (!chosen) return { why: 'resolution has an outcome but no time it became public' };
  return {
    resolution: {
      outcome: chosen.outcome,
      ts: chosen.ts,
      source: chosen.source,
      sources: ev.map((e) => ({ source: e.source, ts_ms: e.ts ?? null })),
    },
  };
}

/** Settlement record with private fields, hidden from strategies until settlement. */
function finalRecord(rec, { start, tradeUntil, resolution }) {
  const { evidence, start_ts_ms: _s, ...rest } = rec;
  return {
    ...rest,
    open_ts_ms: start,
    close_ts_ms: resolution ? resolution.ts : tradeUntil,
    trade_until_ts_ms: tradeUntil,
    outcome: resolution ? resolution.outcome : null,
    resolved_ts_ms: resolution ? resolution.ts : null,
    resolution_source: resolution ? resolution.source : null,
  };
}

/**
 * Decode a whole dataset into per-market event files under `eventsDir`.
 *
 * `frames` is an async iterable of `{ at, line }` (text) or `{ at, frame }`
 * (already parsed); `feed(router)` may instead drive the router directly (the
 * pmdata adapter). Returns entries shaped like the archive path's, plus the
 * dataset counts.
 */
export async function decodeGeneric({ entries, frames = null, feed = null, eventsDir, markMaxAgeMs = null, orderRules = false }) {
  const { markets, rejected, bySlug, byToken } = indexGenericMarkets(entries);
  if (markets.size === 0) {
    throw new DatasetError(`no usable market in the markets file${rejected.length ? ` (${rejected[0].market_id ?? '?'}: ${rejected[0].why})` : ''}`);
  }
  await mkdir(eventsDir, { recursive: true });
  const router = new FrameRouter({ markets, bySlug, byToken });
  const spool = new Map();
  const fileOf = (id) => {
    let f = spool.get(id);
    if (!f) { f = path.join(eventsDir, `raw-${spool.size}.jsonl`); spool.set(id, f); }
    return f;
  };
  const flushIfFull = async (force = false) => {
    for (const id of markets.keys()) {
      const n = router.pending(id);
      if (n && (force || n >= SPOOL_FLUSH)) await appendFile(fileOf(id), `${router.take(id).join('\n')}\n`);
    }
  };
  let sinceFlush = 0;
  if (frames) {
    for await (const item of frames) {
      if (item.line != null) router.line(item.line, item.at);
      else router.frame(item.frame, item.at);
      sinceFlush += 1;
      if (sinceFlush >= SPOOL_FLUSH) { sinceFlush = 0; await flushIfFull(); }
    }
  }
  if (feed) await feed(router);
  await flushIfFull(true);

  const out = [];
  const unusable = rejected.map((r) => ({ market_id: r.market_id, why: r.why }));
  const dropped = { after_trading_end: 0 };
  let k = 0;
  for (const [id, rec] of markets) {
    const st = router.state.get(id);
    const raw = spool.get(id);
    const done = async () => { if (raw) await rm(raw, { force: true }); };
    if (st.bad) { unusable.push({ market_id: id, why: st.bad.why, ...(st.bad.at ? { at: st.bad.at } : {}) }); await done(); continue; }
    if (st.n === 0) { unusable.push({ market_id: id, why: 'no frames for this market' }); await done(); continue; }
    const res = resolutionOf(rec, st.resolution);
    if (res.why) { unusable.push({ market_id: id, why: res.why }); await done(); continue; }
    const resolution = res.resolution;
    const tradeUntil = Math.min(
      rec.trading_end_ts_ms ?? Number.POSITIVE_INFINITY,
      resolution ? resolution.ts - 1 : Number.POSITIVE_INFINITY,
      st.last,
    );
    const start = rec.start_ts_ms ?? st.first;
    if (start > tradeUntil) {
      unusable.push({ market_id: id, why: 'empty window: trading ends before the window starts' });
      await done();
      continue;
    }

    const eventsFile = `m-${k}.jsonl`;
    k += 1;
    const dest = path.join(eventsDir, eventsFile);
    const pre = new Book();
    let preBook = false;
    const quotes = new QuoteState();
    const baseline = new Book();
    let upPx = null;
    let downPx = null;
    let n = 0;
    let books = 0;
    let lines = [];
    const emit = async (ev) => {
      if (ev.kind === 'book') {
        books += 1;
        if (upPx == null) {
          applyBookEvent(baseline, ev, true);
          const u = baseline.best('UP');
          const d = baseline.best('DOWN');
          if (u != null && d != null) { upPx = u; downPx = d; }
        }
      }
      lines.push(JSON.stringify(ev));
      n += 1;
      if (lines.length >= 4096) { await appendFile(dest, `${lines.join('\n')}\n`); lines = []; }
    };
    let opened = false;
    const openWindow = async () => {
      opened = true;
      if (!preBook) return;
      // Replay the opening book as a two-token snapshot at start.
      // Preserve the original quote times in QuoteState.
      await emit({ kind: 'book', ts_ms: start, snapshot: true, synthetic: true, levels: bookLevels(pre), seq: -1, recv_ts_ms: null });
    };
    for await (const ev of sortedEvents(raw, st.n)) {
      if (ev.ts_ms > tradeUntil) { dropped.after_trading_end += 1; continue; }
      quotes.apply(ev);
      if (ev.ts_ms < start) {
        if (ev.kind === 'book') { applyBookEvent(pre, ev, true); preBook = true; }
        continue;
      }
      if (!opened) await openWindow();
      await emit(ev);
    }
    if (!opened) await openWindow();
    if (lines.length) await appendFile(dest, `${lines.join('\n')}\n`);
    await done();
    if (books === 0) {
      await rm(dest, { force: true });
      unusable.push({ market_id: id, why: 'no book inside the trading window' });
      continue;
    }
    if (orderRules && !rulesReadable(rec)) {
      await rm(dest, { force: true });
      unusable.push({ market_id: id, why: 'order_rules "venue" needs this market\'s tick_size (on a 0.0001 grid) and min_size' });
      continue;
    }
    let terminal = null;
    if (!resolution) {
      const m = quotes.mark(tradeUntil, markMaxAgeMs);
      terminal = m.none
        ? { none: m.none }
        : { UP: m.up, DOWN: 1 - m.up, source: m.source, ts_ms: m.ts_ms, age_ms: m.age_ms };
    }
    out.push({
      market: finalRecord(rec, { start, tradeUntil, resolution }),
      stream: null,
      day: null,
      eventsFile,
      n,
      up_px: upPx,
      down_px: downPx,
      terminal,
      resolution_sources: resolution ? resolution.sources : [],
    });
  }
  return { markets: out, unusable, counts: { ...router.counts, ...dropped } };
}

/**
 * Check whether venue order_rules can read tick size and minimum order size.
 * Keep in sync with rules_readable in client/backtest/generic.py.
 */
export function rulesReadable(rec) {
  const tick = rec.tick_size;
  const min = rec.min_size;
  if (typeof tick !== 'number' || !Number.isFinite(tick) || !(tick > 0)) return false;
  const t = Math.round(tick * 10_000);
  if (!(t >= 1) || Math.abs(t - tick * 10_000) > 1e-6) return false;
  return typeof min === 'number' && Number.isFinite(min) && min > 0;
}

/** A generic dataset directory -> decodeGeneric. */
export async function decodeGenericDir(root, { eventsDir, markMaxAgeMs = null, orderRules = false } = {}) {
  const entries = await readMarketsFile(root);
  const files = await datasetFiles(root);
  async function* frames() {
    for (const rel of files) {
      let i = 0;
      for await (const line of fileLines(path.join(root, rel))) {
        i += 1;
        yield { line, at: `${rel}:${i}` };
      }
    }
  }
  const out = await decodeGeneric({ entries, frames: frames(), eventsDir, markMaxAgeMs, orderRules });
  return { ...out, inputs: files };
}
