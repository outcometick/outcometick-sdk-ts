// The data-subscription client: `outcometick/data`.
//
//   import { DataClient } from "outcometick/data";
//   const ot = new DataClient();                       // key from OT_KEY
//   const { files } = await ot.files({ asset: ["btc", "eth"], dataset: "prices" });
//   await ot.download(files[0], "./btc.csv.gz");       // verifies the checksum
//
// Deliberately a SUBPATH, not part of the package root. The root exports the
// strategy SDK — `Strategy` and `Order` — which is what a backtest imports, and
// that code runs in a container with no network at all. Putting an HTTP client
// on the same import would invite a strategy to reach for it, type-check
// locally, and then fail inside the sandbox. Here it cannot be reached by
// accident, and the submission analyser rejects the import outright.
//
// Everything this file knows about the API's shape came from reading
// api/subscription-api.mjs, not from the docs page. The two had drifted: the
// published curl example shows only `asset` and `dataset`, while /v1/files also
// takes a date RANGE and a venue and an interval, and every filter accepts
// comma-separated alternatives plus a `none` sentinel.

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

export const DEFAULT_BASE_URL = 'https://outcometick.com';

/** The sentinel that names files with no value for a dimension. */
export const NO_VALUE = 'none';

/**
 * An API error, carrying whatever the server said alongside the status.
 *
 * The subscription API answers 403 on a date outside coverage with the actual
 * `floor` and `ceiling`, which is the difference between "you cannot have this"
 * and "you cannot have this, here is what you can have". Flattening that into a
 * message string would throw the useful half away.
 */
export class OutcometickError extends Error {
  constructor(status, body, url) {
    const detail = body?.error ?? (typeof body === 'string' ? body.slice(0, 200) : 'request failed');
    super(`${status} ${detail}`);
    this.name = 'OutcometickError';
    this.status = status;
    this.detail = detail;
    this.body = body;
    this.url = url;
  }
}

/**
 * Render one filter value.
 *
 * Arrays join with commas because that is exactly what the API means by
 * `asset=btc,eth` — alternatives, not a nested structure. Passing an array is
 * the friendlier spelling of the same request, so both work.
 */
function filterValue(v) {
  if (v == null) return null;
  const parts = (Array.isArray(v) ? v : [v])
    .map((x) => String(x).trim())
    .filter(Boolean);
  return parts.length ? parts.join(',') : null;
}

export class DataClient {
  /**
   * @param opts.key      API key. Defaults to process.env.OT_KEY.
   * @param opts.baseUrl  API origin. Defaults to https://outcometick.com.
   * @param opts.fetch    Injectable for tests.
   */
  constructor({ key = null, baseUrl = DEFAULT_BASE_URL, fetch: fetchImpl = null } = {}) {
    // Read at construction so the failure is "you have not set a key", raised
    // once and early, rather than a 401 from whichever call happened to be
    // first.
    this.key = key ?? process.env.OT_KEY ?? null;
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this._fetch = fetchImpl ?? globalThis.fetch;
  }

  /** The key, or a readable explanation of its absence. */
  _requireKey() {
    if (!this.key) {
      throw new Error('no API key.\n'
        + '  Pass one as new DataClient({ key }), or set OT_KEY:\n'
        + '    export OT_KEY="ck_…"');
    }
    return this.key;
  }

  async _get(path, { query = null, auth = true, redirect = 'follow' } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      const value = filterValue(v);
      if (value !== null) url.searchParams.set(k, value);
    }
    const headers = auth ? { authorization: `Bearer ${this._requireKey()}` } : {};

    let res;
    try {
      res = await this._fetch(url, { headers, redirect });
    } catch (err) {
      throw new Error(`could not reach ${this.baseUrl}: ${err.message}`);
    }
    return { res, url: url.toString() };
  }

  async _json(path, opts = {}) {
    const { res, url } = await this._get(path, opts);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    if (!res.ok) throw new OutcometickError(res.status, body, url);
    return body;
  }

  // ---------- discovery -------------------------------------------------

  /**
   * What this key can see: the date window, and every dimension value in it.
   *
   * `assets` and `intervals` hold real symbols and real durations only. The
   * `none` sentinel is reported separately under `filterTokens`, because a
   * client that builds an enum from `intervals` or parses them as durations
   * must not meet a token.
   */
  async meta() {
    return this._json('/v1/meta');
  }

  /** The days this key may download, with the window's floor and ceiling. */
  async days() {
    return this._json('/v1/mirror/days');
  }

  /**
   * Search for files across a date range.
   *
   * @param q.date      one day — sugar for from === to. Cannot be combined
   *                    with from/to.
   * @param q.from      inclusive start; defaults to the newest day in scope.
   * @param q.to        inclusive end; defaults to `from`.
   * @param q.venue     polymarket | predict-fun
   * @param q.dataset   prices | twap60s | book | klines | …  (see meta())
   * @param q.asset     the BASE symbol — BTC, ETH, SOL, … NOT the pair.
   *                    Files are named BTCUSD-…, but the asset dimension is
   *                    BTC; asking for "BTCUSD" matches nothing.
   * @param q.interval  5m, 1h, … or "none" for the streams that have no period
   *
   * Every filter accepts a string or an array; an array is joined with commas
   * and means "any of these". `interval: ["5m", NO_VALUE]` is how you ask for
   * 5-minute files AND the period-less settlement streams — asking for "5m"
   * alone deliberately excludes them.
   *
   * The server caps the range (92 days by default) and answers 400 past it.
   */
  async files(q = {}) {
    if (q.date && (q.from || q.to)) {
      // The server rejects this too; catching it here saves a round trip and
      // says the same thing, so the two cannot describe it differently.
      throw new Error('use either date, or from/to — not both');
    }
    return this._json('/v1/files', {
      query: {
        date: q.date, from: q.from, to: q.to,
        venue: q.venue, dataset: q.dataset, asset: q.asset, interval: q.interval,
      },
    });
  }

  // ---------- download --------------------------------------------------

  /**
   * A presigned URL for one file, without fetching it.
   *
   * Useful when something else does the fetching — a data frame library, a job
   * runner, a browser. The URL is short-lived; hold the `{date, name}` pair and
   * ask again rather than storing it.
   */
  async signUrl(date, name, { expiresIn = null } = {}) {
    return this._json('/v1/mirror/download', {
      query: { date, name, ...(expiresIn ? { expiresIn } : {}) },
    });
  }

  /**
   * Download one file.
   *
   * Accepts either a row from files() or an explicit (date, name).
   *
   * The checksum is verified by default. /v1/dl answers 302 with the sha256 in
   * a header and the bytes come from R2 behind the redirect, so the redirect is
   * followed MANUALLY: letting fetch follow it would discard the header and
   * with it the only checksum available without a second API call. A row from
   * files() carries its own sha256, which is used when present.
   *
   * @returns {Promise<{bytes: Uint8Array, sha256: string|null, name: string, date: string}>}
   */
  async download(fileOrDate, nameOrOpts = null, maybeOpts = null) {
    const isRow = fileOrDate && typeof fileOrDate === 'object';
    const date = isRow ? fileOrDate.date : fileOrDate;
    const name = isRow ? fileOrDate.name : nameOrOpts;
    const opts = (isRow ? nameOrOpts : maybeOpts) ?? {};
    const { verify = true, saveTo = null } = opts;

    if (!date || !name) throw new Error('download needs a file row, or a date and a name');

    const { bytes, sha256 } = await this._downloadVia(
      `/v1/dl/${encodeURIComponent(date)}/${encodeURIComponent(name)}`, null,
      isRow ? (fileOrDate.sha256 ?? null) : null, `${date}/${name}`, { verify, saveTo },
    );
    return { bytes, sha256, name, date };
  }

  /**
   * GET a route that answers 302 to a signed URL, fetch the bytes, verify them.
   * Shared by the archive and smart-money downloads.
   */
  async _downloadVia(path, query, expected, label, { verify = true, saveTo = null } = {}) {
    const { res, url } = await this._get(path, { query, redirect: 'manual' });
    let bytesRes = res;

    if (res.status >= 300 && res.status < 400) {
      expected = expected
        ?? res.headers.get('x-outcometick-sha256')
        ?? res.headers.get('x-amz-meta-sha256')
        ?? null;
      const location = res.headers.get('location');
      if (!location) throw new OutcometickError(res.status, { error: 'redirect with no location' }, url);
      // The signed URL carries its own auth; sending ours to R2 as well would
      // leak the key to a host that has no use for it.
      bytesRes = await this._fetch(location, { redirect: 'follow' });
    }

    if (!bytesRes.ok) {
      const text = await bytesRes.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      throw new OutcometickError(bytesRes.status, body, url);
    }

    const bytes = new Uint8Array(await bytesRes.arrayBuffer());

    if (verify && expected) {
      const got = createHash('sha256').update(bytes).digest('hex');
      if (got !== expected) {
        throw new Error(`checksum mismatch for ${label}\n`
          + `  expected ${expected}\n  got      ${got}`);
      }
    }

    if (saveTo) await writeFile(saveTo, bytes);
    return { bytes, sha256: expected };
  }

  // ---------- smart money -----------------------------------------------
  //
  // A separate subscription with its OWN key (a data key gets 403 here, and a
  // smart-money key gets 403 on everything above). Daily files of the trades
  // made by the top-ranked Polymarket traders: list top100, or top1000 on the
  // Top 1000 plan. While it is not on sale these answer 503.

  /** The days this smart-money key may download, newest first, each list's status. */
  async smartDays() {
    return this._json('/v1/smart/days');
  }

  /**
   * Download one day's smart-money file (a zstd-compressed CSV), verified
   * against the sha256 the server sends with the redirect.
   *
   * @param day   'YYYY-MM-DD' — take it from smartDays(), not from the calendar
   * @param list  'top100' | 'top1000'
   * @returns {Promise<{bytes: Uint8Array, sha256: string|null, day: string, list: string}>}
   */
  async smartDownload(day, list = 'top100', { verify = true, saveTo = null } = {}) {
    if (!day) throw new Error('smartDownload needs a day');
    if (list !== 'top100' && list !== 'top1000') throw new Error("list must be 'top100' or 'top1000'");
    const { bytes, sha256 } = await this._downloadVia(
      '/v1/smart/download', { day, list }, null, `${day}/${list}`, { verify, saveTo },
    );
    return { bytes, sha256, day, list };
  }

  // ---------- public, no key needed -------------------------------------

  /** Coverage across all venues. Public — works without a key. */
  async coverage() {
    return this._json('/v1/public/coverage', { auth: false });
  }

  /** Plans and live prices. Public. */
  async plans() {
    return this._json('/v1/public/plans', { auth: false });
  }

  /** How many smart-money days are published, and from when. Public. */
  async smartCoverage() {
    return this._json('/v1/public/smart-coverage', { auth: false });
  }

  /** Smart-money plans and prices (USD), and whether it is on sale. Public. */
  async smartPlans() {
    return this._json('/v1/public/smart-plans', { auth: false });
  }

  /** Liveness. Public. */
  async health() {
    return this._json('/v1/health', { auth: false });
  }
}

// ---------- rebuilding a Polymarket order book from archive rows ----------

/**
 * A finite number, or NaN. Only a finite number or a plain decimal string
 * ("0.5", "12", "1e-1") counts: Number() would read "", " ", [] and null as 0,
 * and a 0 best bid would wipe every bid. Same rule as the Python client.
 */
const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const num = (x) => {
  if (typeof x === 'number') return Number.isFinite(x) ? x : NaN;
  if (typeof x === 'string' && NUMERIC.test(x)) { const n = Number(x); return Number.isFinite(n) ? n : NaN; } // "1e400"
  return NaN;
};
/** "0.50" and "0.5" are the same level. */
const priceKey = (p) => String(Number(p));
const ladderSide = (side) => {
  const s = String(side ?? '').toUpperCase();
  return s === 'BUY' ? 'bids' : s === 'SELL' ? 'asks' : null;
};
/** A best price that can be pruned against: a number in [0, 1]. */
const pruneBound = (x) => { const n = num(x); return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null; };

/**
 * Rebuilds a Polymarket order book, per outcome token, from the archive's
 * `book`, `price_change` and `best_bid_ask` rows fed in receipt order
 * (`recv_ms`; merge the three files by it).
 *
 *   const book = new OrderBook();
 *   for (const row of rows) book.apply(row);
 *   book.ladder(tokenId);   // { bids: [{ price, size }, ...], asks: [...] }, best first
 *
 * - `book` replaces that token's whole ladder.
 * - `price_change` sets each level to an absolute size; size 0 removes it.
 * - Then any bid above the best bid, or ask below the best ask, is dropped —
 *   the best prices come from `best_bid_ask` and from the `best_bid`/`best_ask`
 *   each `price_change` item carries.
 *
 * Why the last step: book and price_change are captured at a cadence, so a
 * removal can fall between two stored frames and leave its level behind until
 * the next snapshot. Pruning against the newest best prices removes every
 * level they have moved past. It cannot restore what dropped frames added or
 * resized: until the next snapshot a level — at the top too — can be missing
 * or carry an old size, because best_bid_ask carries prices only. best() is the
 * best level of the rebuilt ladder, not the market's latest best bid and ask;
 * read best_bid_ask rows for those.
 *
 * Prices and sizes are returned as the archive wrote them (strings). Rows of
 * other types are ignored. Predict.fun order-book rows are full snapshots on
 * their own and need none of this.
 */
export class OrderBook {
  constructor() {
    /** @type {Map<string, { bids: Map<string, {price: string, size: string}>, asks: Map<string, {price: string, size: string}> }>} */
    this._tokens = new Map();
  }

  _ladders(assetId) {
    let l = this._tokens.get(assetId);
    if (!l) { l = { bids: new Map(), asks: new Map() }; this._tokens.set(assetId, l); }
    return l;
  }

  _prune(assetId, bestBid, bestAsk) {
    const l = this._tokens.get(assetId);
    if (!l) return;
    const bid = pruneBound(bestBid);
    const ask = pruneBound(bestAsk);
    if (bid !== null) for (const [k, lvl] of l.bids) if (Number(lvl.price) > bid) l.bids.delete(k);
    if (ask !== null) for (const [k, lvl] of l.asks) if (Number(lvl.price) < ask) l.asks.delete(k);
  }

  /** Apply one archive row (an object, or the JSONL line itself). Returns this. */
  apply(row) {
    const r = typeof row === 'string' ? JSON.parse(row) : row;
    const p = r?.payload ?? {};
    const type = r?.event_type ?? p.event_type;
    const rowAsset = r?.asset_id ?? p.asset_id ?? null;
    if (type === 'book') {
      if (rowAsset == null) return this;
      const l = this._ladders(String(rowAsset));
      for (const side of ['bids', 'asks']) {
        l[side].clear();
        for (const lvl of Array.isArray(p[side]) ? p[side] : []) {
          const price = Array.isArray(lvl) ? lvl[0] : lvl?.price;
          const size = Array.isArray(lvl) ? lvl[1] : lvl?.size;
          if (!Number.isNaN(num(price)) && num(size) > 0) l[side].set(priceKey(price), { price: String(price), size: String(size) });
        }
      }
    } else if (type === 'price_change') {
      const items = Array.isArray(p.price_changes) ? p.price_changes : Array.isArray(p.changes) ? p.changes : [];
      const bests = new Map(); // token -> the last item's best prices
      for (const it of items) {
        const asset = it?.asset_id ?? rowAsset;
        const side = ladderSide(it?.side);
        const size = num(it?.size);
        if (asset == null || side === null || Number.isNaN(num(it.price)) || Number.isNaN(size)) continue;
        const l = this._ladders(String(asset));
        if (size > 0) l[side].set(priceKey(it.price), { price: String(it.price), size: String(it.size) });
        else l[side].delete(priceKey(it.price));
        bests.set(String(asset), it);
      }
      for (const [asset, it] of bests) this._prune(asset, it.best_bid, it.best_ask);
    } else if (type === 'best_bid_ask') {
      if (rowAsset != null) this._prune(String(rowAsset), p.best_bid, p.best_ask);
    }
    return this;
  }

  /** Token ids seen so far. */
  assets() {
    return [...this._tokens.keys()];
  }

  /** The token's ladder, best level first on each side. */
  ladder(assetId) {
    const l = this._tokens.get(String(assetId));
    if (!l) return { bids: [], asks: [] };
    return {
      bids: [...l.bids.values()].sort((a, b) => Number(b.price) - Number(a.price)).map((x) => ({ ...x })),
      asks: [...l.asks.values()].sort((a, b) => Number(a.price) - Number(b.price)).map((x) => ({ ...x })),
    };
  }

  /** The best bid and ask of the rebuilt ladder (null when that side is empty). */
  best(assetId) {
    const { bids, asks } = this.ladder(assetId);
    return { bid: bids[0] ?? null, ask: asks[0] ?? null };
  }
}

export default DataClient;
