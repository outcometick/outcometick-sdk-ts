// Point-in-time views of reference and external series.
// Rows become visible at ts_ms + lagMs. Views expose frozen row copies and
// cannot read past that publication horizon.

/** Frozen, prototype-less copy of one row. */
function freezeRow(row) {
  const out = Object.create(null);
  for (const k of Object.keys(row)) out[k] = row[k];
  return Object.freeze(out);
}

export class PointInTimeFeed {
  /**
   * @param rows   ascending by ts_ms; owned by this class, not copied.
   * @param lagMs  publication delay; a row becomes visible at ts_ms + lagMs.
   */
  constructor(rows, { lagMs = 0 } = {}) {
    this.rows = rows;
    this.lagMs = Number(lagMs) || 0;
    // Forward replay walks each feed once. A fresh feed is built per market.
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
    // Capture the feed lag; view methods have a different this.
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

      /** Row in effect at ts, clamped to the current publication horizon. */
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
