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

    const { res, url } = await this._get(
      `/v1/dl/${encodeURIComponent(date)}/${encodeURIComponent(name)}`,
      { redirect: 'manual' },
    );

    let expected = isRow ? (fileOrDate.sha256 ?? null) : null;
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
        throw new Error(`checksum mismatch for ${date}/${name}\n`
          + `  expected ${expected}\n  got      ${got}`);
      }
    }

    if (saveTo) await writeFile(saveTo, bytes);
    return { bytes, sha256: expected, name, date };
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

  /** Liveness. Public. */
  async health() {
    return this._json('/v1/health', { auth: false });
  }
}

export default DataClient;
