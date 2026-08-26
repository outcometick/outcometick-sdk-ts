// Point-in-time views over an out-of-band series.
//
// `ctx.ref(name)` and `ctx.ext(name)` both call `feed.viewAt(ctx.now)` and hand
// the result to the strategy. Until now nothing implemented `viewAt`: the
// manifest validator accepted `reference` and `series`, the run was queued and
// billed, and the strategy crashed on its first `ctx.ref(...)` with a message
// claiming the feed had not been declared — which it had.
//
// Two properties this file exists to guarantee:
//
//   1. NOTHING STAMPED AFTER ctx.now IS REACHABLE. Not filtered on the way out
//      — the cursor never advances past `now`, so a later row is not something
//      the strategy can ask for. That is the same promise the event replay
//      makes, and a reference feed is exactly where it would otherwise leak:
//      the whole point of an outside series is that we hold all of it up front.
//
//   2. WHAT THE STRATEGY GETS IS A COPY. `ctx.book()` and `ctx.history()` were
//      both caught handing out live objects a strategy could rewrite, and a
//      rewritten reference row would poison every later window() over it.
//
// `lagMs` models publication delay: a row is not visible until ts_ms + lagMs,
// which is how you backtest a signal you could not have had instantly.

/** Frozen, prototype-less copy of one row. */
function freezeRow(row) {
  const out = Object.create(null);
  for (const k of Object.keys(row)) out[k] = row[k];
  return Object.freeze(out);
}

export class PointInTimeFeed {
  /**
   * @param rows   ascending by ts_ms. Not copied — this class owns them and
   *               never hands one out directly.
   * @param lagMs  publication delay; a row becomes visible at ts_ms + lagMs.
   */
  constructor(rows, { lagMs = 0 } = {}) {
    this.rows = rows;
    this.lagMs = Number(lagMs) || 0;
    // Monotone cursor: the replay only ever moves forward, so the whole feed is
    // walked once across a market-day rather than binary-searched per call.
    // `ctx.now` never goes backwards within a market — but a fresh feed is
    // built per market, so this is not an assumption about the strategy.
    this.cursor = 0;
  }

  /** Index one past the last row visible at `now`. */
  _visibleCount(now) {
    const limit = now - this.lagMs;
    while (this.cursor < this.rows.length && this.rows[this.cursor].ts_ms <= limit) {
      this.cursor += 1;
    }
    // Defensive: if time moved backwards, do not report rows from the future.
    if (this.cursor > 0 && this.rows[this.cursor - 1].ts_ms > limit) {
      let i = this.cursor;
      while (i > 0 && this.rows[i - 1].ts_ms > limit) i -= 1;
      return i;
    }
    return this.cursor;
  }

  viewAt(now) {
    const n = this._visibleCount(now);
    const rows = this.rows;
    // Captured, not read off `this`: the object below is what the strategy
    // holds, so `this` inside its methods is that frozen view — `this.lagMs`
    // was undefined there and turned the clamp into NaN, which made at() return
    // null for every timestamp.
    const { lagMs } = this;
    const horizon = now - lagMs;
    return Object.freeze({
      /** The most recent row at or before now, or null. */
      get last() { return n > 0 ? freezeRow(rows[n - 1]) : null; },

      /** The last `k` visible rows, oldest first. Never more than exist. */
      window(k) {
        const want = Math.max(0, Math.min(Number(k) || 0, n));
        const out = [];
        for (let i = n - want; i < n; i += 1) out.push(freezeRow(rows[i]));
        return out;
      },

      /**
       * The row in effect at `ts`. Clamped to now: asking for a later
       * timestamp cannot reach a later row.
       */
      at(ts) {
        const asked = Number(ts);
        const t = Number.isFinite(asked) ? Math.min(asked, horizon) : horizon;
        let lo = 0;
        let hi = n - 1;
        let found = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (rows[mid].ts_ms <= t) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
        }
        return found >= 0 ? freezeRow(rows[found]) : null;
      },
    });
  }
}

/**
 * Build the feeds a run declared, keyed by the name the strategy will ask for.
 *
 * @param declared  manifest names, e.g. ['binance:btcusdt:spot:1s']
 * @param rowsByName  name -> ascending rows
 * @param lagByName   name -> publication lag in ms
 */
export function buildFeeds(declared, rowsByName, lagByName = {}) {
  const out = new Map();
  for (const name of declared ?? []) {
    out.set(name, new PointInTimeFeed(rowsByName[name] ?? [], { lagMs: lagByName[name] ?? 0 }));
  }
  return out;
}
