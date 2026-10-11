// Session mode's stream: every market of a run, merged into ONE time order.
//
// Session mode shares one strategy instance and one portfolio across the whole
// range. It used to be fed exactly like market mode — each market's events in
// full, one market after another — which is fine while markets never overlap
// and a look-ahead hole the moment they do: a 15-minute market open
// 00:00–00:15 was replayed to its end before a 5-minute market that opened at
// 00:05, so whatever the instance learned at 00:15 was already in hand when it
// started trading 00:05. Two assets, or 5m and 15m together, overlap all day.
//
// So the session stream is a k-way merge by event time, and the harness drives
// every open market from it (runner/harness/node/harness.mjs `runSession`,
// otharness.py `_run_session`). Three kinds of line:
//
//   {"open":{"i":k, market, stream, references?, series?, lags?}}
//   {"i":k,"e":<event or feed row>}
//   {"close":k}
//
// SHARED by the worker and `ot run` for the reason everything in runner/ that
// both of them do is shared: the two have drifted nine times. The pure-Python
// local backtest ports it (outcometick/backtest/feed.py) and the equivalence
// suite compares the two outputs line for line.

/**
 * When a line becomes visible, without parsing a whole event.
 *
 * Events carry `ts_ms`. Feed rows (`ref`/`ext`) were placed in the market's
 * stream by WHEN THEY BECOME READABLE — stamp plus the feed's declared lag
 * (mergeReferenceRows) — so that is their position here too; releasing one at
 * its stamp would hand a lagged row to the strategy before it could have
 * existed.
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
 * A binary heap of market cursors, ordered by (time, phase, s, market index).
 * `s` is 0 for every archive cursor — so the archive order is exactly (time,
 * phase, market index) — and the global input sequence for a generic event.
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
 * The session stream for a run.
 *
 * @param {Array} markets  in session order (sortMarketsForReplay mode 'session':
 *   opening time, then id) — the index in this list is the market's `i`.
 * @param {object} opts
 * @param {(m:object)=>Promise<string[]>} opts.linesOf  one market's lines, in
 *   order, feed rows already merged in (what market mode would send after its
 *   header).
 * @param {(m:object)=>object} opts.headerOf  the market-mode header minus `n`.
 * @yields {string} protocol lines, without newlines
 *
 * A market is opened when the merge reaches its opening time, so only the
 * markets live at one moment are held in memory, never the whole range.
 * Ties: at one millisecond, an opening comes first, then events in market
 * order, then closings — so a market can trade on the instant it opens, and
 * every event stamped at a market's close reaches it before it settles.
 */
export async function* sessionLines(markets, { linesOf, headerOf, cursorOf = null, timed = false }) {
  // `timed` (phase 2b, the global scheduler): every line carries the time it was
  // ordered by as "t", and the harness schedules by that and nothing else — so
  // producer and consumer cannot disagree about when a line happened.
  const T = (t) => (timed ? `,"t":${Number.isFinite(t) ? t : 'null'}` : '');
  const heap = new CursorHeap();
  const openAt = (m) => {
    const v = m?.market?.open_ts_ms;
    return typeof v === 'number' && Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY;
  };
  let next = 0;

  /**
   * A GENERIC market (runner/generic-data.mjs) is read as a stream, one line of
   * look-ahead, so a months-long market is never held whole. Its lifecycle has
   * two closing instants: `end` at trade_until (phase 2), then `close` at its
   * settlement (phase 3). Events tie-break on the global input sequence.
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
      // Each line's time, made monotone within the market: the stream is
      // already in order, so a line whose time cannot be read sits where it is.
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
