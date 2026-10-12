// Merge session markets by event time. One strategy instance and portfolio
// span the range, so overlapping markets must be interleaved to avoid look-ahead.
// The harnesses consume a k-way merge with these archive protocol lines:
//
//   {"open":{"i":k, market, stream, references?, series?, lags?}}
//   {"i":k,"e":<event or feed row>}
//   {"close":k}
//
// Shared by the worker and ot run. Keep in sync with client/backtest/feed.py;
// the equivalence suite compares protocol lines.

/**
 * Read a line's visibility time without parsing the event.
 * Market events use ts_ms; ref/ext rows use ts_ms plus their declared lag,
 * matching mergeReferenceRows.
 */
function lineTime(line, lags) {
  const m = /"ts_ms"\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(line);
  let ts = m ? Number(m[1]) : Number.NaN;
  if (line.startsWith('{"kind":"ext"') || line.startsWith('{"kind":"ref"')) {
    try {
      const row = JSON.parse(line);
      const lag = Number(lags?.[row.name]) || 0;
      ts = Number(row.ts_ms) + lag;
    } catch { /* positioned by the running time below */ }
  }
  return ts;
}

/** A generic event line's global input sequence (runner/generic-data.mjs). */
function lineSeq(line) {
  const m = /"seq"\s*:\s*(-?\d+)/.exec(line);
  return m ? Number(m[1]) : 0;
}

/**
 * Heap of market cursors ordered by (time, phase, s, market index).
 * s is 0 for archive cursors and the global input sequence for generic events.
 */
class CursorHeap {
  constructor() { this.a = []; }

  get size() { return this.a.length; }

  peek() { return this.a[0]; }

  static less(x, y) {
    if (x.t !== y.t) return x.t < y.t;
    if (x.phase !== y.phase) return x.phase < y.phase;
    if (x.s !== y.s) return x.s < y.s;
    return x.k < y.k;
  }

  push(c) {
    const a = this.a;
    a.push(c);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!CursorHeap.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }

  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < a.length && CursorHeap.less(a[l], a[s])) s = l;
        if (r < a.length && CursorHeap.less(a[r], a[s])) s = r;
        if (s === i) break;
        [a[i], a[s]] = [a[s], a[i]];
        i = s;
      }
    }
    return top;
  }
}

/**
 * Merge markets into the session protocol stream.
 *
 * @param {Array} markets  opening-time/id order (sortMarketsForReplay session
 *   mode); the list index is the market's i.
 * @param {object} opts
 * @param {(m:object)=>Promise<string[]>} opts.linesOf  ordered market lines
 *   with feed rows already merged, as sent after a market-mode header.
 * @param {(m:object)=>object} opts.headerOf  market-mode header without n.
 * @yields {string} protocol lines without newlines
 *
 * Open markets at their opening times, holding only currently live markets.
 * At equal times, opens precede events and closes follow them. Archive events
 * tie-break by market order; generic events use global input sequence.
 */
export async function* sessionLines(markets, { linesOf, headerOf, cursorOf = null, timed = false }) {
  // With timed=true, include the merge time as t for the harness scheduler.
  const T = (t) => (timed ? `,"t":${Number.isFinite(t) ? t : 'null'}` : '');
  const heap = new CursorHeap();
  const openAt = (m) => {
    const v = m?.market?.open_ts_ms;
    return typeof v === 'number' && Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY;
  };
  let next = 0;

  /**
   * Read generic markets with one line of look-ahead. Emit end at trade_until
   * (phase 2) and close at settlement (phase 3). Events tie-break by input sequence.
   */
  const advanceGeneric = async (c) => {
    const nx = await c.it.next();
    if (!nx.done) {
      const line = nx.value;
      const t = lineTime(line, null);
      if (Number.isFinite(t) && t > c.run) c.run = t;
      c.line = line;
      c.t = c.run;
      c.phase = 1;
      c.s = lineSeq(line);
    } else if (!c.endSent) {
      c.line = null;
      c.t = Math.max(c.endAt, c.run);
      c.phase = 2;
      c.s = 0;
    } else {
      c.line = null;
      c.t = Math.max(c.closeAt, c.t);
      c.phase = 3;
      c.s = 0;
    }
    heap.push(c);
  };

  const advance = (c) => {
    if (c.i < c.lines.length) {
      const t = c.times[c.i];
      c.t = t;
      c.phase = 1;
    } else {
      c.t = c.closeAt;
      c.phase = 2;
    }
    c.s = 0;
    heap.push(c);
  };

  for (;;) {
    const top = heap.peek();
    if (next < markets.length && (top == null || openAt(markets[next]) <= top.t)) {
      const k = next;
      const m = markets[next];
      next += 1;
      const header = headerOf(m);
      if (m?.market?.kind === 'generic') {
        if (!cursorOf) throw new Error('a generic market needs a streaming cursor (cursorOf)');
        yield timed ? JSON.stringify({ open: { i: k, ...header }, t: Number.isFinite(openAt(m)) ? openAt(m) : null })
          : JSON.stringify({ open: { i: k, ...header } });
        await advanceGeneric({
          k,
          generic: true,
          it: cursorOf(m)[Symbol.asyncIterator](),
          run: openAt(m),
          endAt: m.market.trade_until_ts_ms,
          closeAt: m.market.close_ts_ms,
          endSent: false,
          line: null,
          t: 0,
          phase: 0,
          s: 0,
        });
        continue;
      }
      const lines = await linesOf(m);
      const lags = header.lags ?? null;
      // Keep times monotone within each market. Unreadable times inherit
      // the previous time without moving the line.
      const times = new Array(lines.length);
      let run = openAt(m);
      for (let j = 0; j < lines.length; j += 1) {
        const t = lineTime(lines[j], lags);
        if (Number.isFinite(t) && t > run) run = t;
        times[j] = run;
      }
      const declared = m?.market?.close_ts_ms;
      const closeAt = typeof declared === 'number' && Number.isFinite(declared)
        ? Math.max(declared, run)
        : run;
      yield timed ? JSON.stringify({ open: { i: k, ...header }, t: Number.isFinite(openAt(m)) ? openAt(m) : null })
        : JSON.stringify({ open: { i: k, ...header } });
      advance({ k, lines, times, i: 0, closeAt, t: 0, phase: 0 });
      continue;
    }
    if (top == null) break;
    const c = heap.pop();
    if (c.generic) {
      if (c.phase === 1) {
        yield `{"i":${c.k}${T(c.t)},"e":${c.line}}`;
      } else if (c.phase === 2) {
        yield `{"end":${c.k}${T(c.t)}}`;
        c.endSent = true;
      } else {
        yield `{"close":${c.k}${T(c.t)}}`;
        continue;
      }
      await advanceGeneric(c);
      continue;
    }
    if (c.phase === 2) {
      yield `{"close":${c.k}${T(c.t)}}`;
      continue;
    }
    yield `{"i":${c.k}${T(c.t)},"e":${c.lines[c.i]}}`;
    c.i += 1;
    advance(c);
  }
}
