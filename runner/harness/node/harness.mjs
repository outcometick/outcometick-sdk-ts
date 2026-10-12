#!/usr/bin/env node
// Node.js sandbox entrypoint, running in the strategy's process.
// The container provides isolation; this harness validates hooks, measures
// event budgets and emits authenticated results.
//
//   node harness.mjs <job-dir>      job on stdin, results on stdout

import { readSync, writeSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MarketReplay, makeLogBudget, BudgetMonitor, RunAbort } from '../../engine/replay.mjs';
import { Book as BookCls } from '../../engine/book.mjs';
import { buildFeeds } from '../../engine/feed.mjs';
import { Portfolio, newOrderStats } from '../../engine/portfolio.mjs';
import { rowPending, newMakerStats, addMakerStats } from '../../engine/maker.mjs';
import { CHANNEL, RESULT_FD, EXIT, RECORD_FIELDS, MAX_RECORD_ROWS, MAX_RECORD_BYTES, lineBytes } from '../protocol.mjs';

/**
 * Replace console before importing strategy code. Patching methods leaves
 * console._stdout and console.Console able to write to the result channel.
 * MACs reject forged lines, but stray writes can corrupt valid framing.
 * The replacement holds no streams; use the bounded ctx.log channel.
 */
let warnedAboutConsole = false;
function consoleIsGone() {
  // Warn once on stderr, which ot run displays.
  if (warnedAboutConsole) return undefined;
  warnedAboutConsole = true;
  try {
    writeSync(2, 'harness: console output is discarded — use ctx.log() instead\n');
  } catch { /* stderr is not worth crashing a run over */ }
  return undefined;
}
globalThis.console = Object.freeze(Object.fromEntries(
  // Keep documented methods as no-ops. Exclude _stdout, _stderr and Console,
  // which expose writable streams.
  [
    'assert', 'clear', 'count', 'countReset', 'debug', 'dir', 'dirxml', 'error',
    'group', 'groupCollapsed', 'groupEnd', 'info', 'log', 'profile',
    'profileEnd', 'table', 'time', 'timeEnd', 'timeLog', 'timeStamp', 'trace',
    'warn',
  ].map((m) => [m, consoleIsGone]),
));


/**
 * Protect built-ins before importing strategies. Strategies share the engine's
 * realm; patched methods, inherited setters, iterators and global bindings can
 * expose engine state or alter replay. Static analysis alone cannot stop aliases.
 *
 * Accessors on constructors, Object.prototype, Function.prototype, Math and
 * Reflect allow overrides on derived objects and same-value assignments to
 * built-ins. Assignments that change a built-in throw. Other prototypes are
 * frozen directly: accessor lookups on hot paths doubled replay time in sandbox
 * measurements. runner/sandbox.test.mjs checks package compatibility.
 */
{
  const { defineProperty, getOwnPropertyDescriptors, freeze, getPrototypeOf } = Object;
  const ownKeys = Reflect.ownKeys;
  const tame = (proto) => {
    const descs = getOwnPropertyDescriptors(proto);
    for (const key of ownKeys(descs)) {
      const d = descs[key];
      if (!('value' in d) || !d.writable || !d.configurable) continue;
      const value = d.value;
      defineProperty(proto, key, {
        configurable: false,
        enumerable: d.enumerable,
        get() { return value; },
        set(v) {
          if (this === proto) {
            if (v === value) return;
            throw new TypeError(`Cannot assign to read only property '${String(key)}' of a built-in`);
          }
          defineProperty(this, key, { value: v, writable: true, enumerable: true, configurable: true });
        },
      });
    }
    freeze(proto);
  };
  const arrayIter = getPrototypeOf([][Symbol.iterator]());
  const generator = getPrototypeOf(function* g() {});
  const typedArray = getPrototypeOf(Float64Array);
  for (const target of [
    Array, Array.prototype, arrayIter, getPrototypeOf(arrayIter),
    Map, Map.prototype, getPrototypeOf(new Map()[Symbol.iterator]()),
    Set, Set.prototype, getPrototypeOf(new Set()[Symbol.iterator]()),
    WeakMap, WeakMap.prototype, WeakSet, WeakSet.prototype,
    generator, generator.prototype,
    String, String.prototype, getPrototypeOf(''[Symbol.iterator]()),
    RegExp, RegExp.prototype, Number, Number.prototype, Boolean, Boolean.prototype,
    Symbol, Symbol.prototype, BigInt, BigInt.prototype, Promise, Promise.prototype,
    typedArray, typedArray.prototype, Float64Array, Float64Array.prototype,
    Uint8Array, Uint8Array.prototype, Buffer, Buffer.prototype,
    Object.prototype, Function.prototype,
    Math, Object, Reflect,
  ]) {
    if (typeof target === 'function' || target === Object.prototype || target === Function.prototype
        || target === Math || target === Reflect) tame(target);
    else freeze(target);
  }
  // The names engine code looks up at call time. JSON keeps a writable
  // property set (its parse is captured below, and nothing else is used for
  // output), but the binding is fixed like the rest.
  for (const name of [
    'Object', 'Function', 'Array', 'Map', 'Set', 'WeakMap', 'WeakSet', 'String', 'Number',
    'Boolean', 'Symbol', 'BigInt', 'Promise', 'RegExp', 'Math', 'JSON', 'Reflect', 'Buffer',
    'Float64Array', 'Uint8Array', 'Error', 'TypeError', 'console',
  ]) {
    defineProperty(globalThis, name, { value: globalThis[name], writable: false, configurable: false, enumerable: false });
  }
}

/**
 * Capture the parser before strategy import to prevent JSON.parse rebinding
 * from intercepting the job stream.
 */
const parseJson = JSON.parse;

/**
 * Serialise protocol values without JSON.stringify or inherited toJSON hooks.
 * Capturing stringify alone still permits prototype lookups on arrays and boxed
 * primitives. Supports numbers, strings, booleans, null, arrays and objects.
 */
const ESCAPES = {
  '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t',
  '\b': '\\b', '\f': '\\f',
};

function jsonString(str) {
  let out = '"';
  for (const ch of String(str)) {
    const esc = ESCAPES[ch];
    if (esc) out += esc;
    else if (ch < ' ') out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

function stringify(value) {
  if (value === null || value === undefined) return 'null';
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return jsonString(value);
  if (Array.isArray(value)) return `[${value.map(stringify).join(',')}]`;
  if (t === 'object') {
    const parts = [];
    for (const k of Object.keys(value)) {
      const v = stringify(value[k]);
      if (v !== undefined) parts.push(`${jsonString(k)}:${v}`);
    }
    return `{${parts.join(',')}}`;
  }
  return 'null';
}

/**
 * Project known fields onto a null-prototype object with primitive values.
 * Remove inherited hooks and object-valued fields before serialisation.
 */
function projectRow(row, fields) {
  const out = Object.create(null);
  for (const f of fields) {
    const v = row[f];
    if (v == null) out[f] = null;
    else if (typeof v === 'number') out[f] = Number.isFinite(v) ? Number(v) : null;
    else if (typeof v === 'boolean') out[f] = Boolean(v);
    else out[f] = String(v);
  }
  return out;
}

/**
 * Deep-copy results into primitives, arrays and null-prototype objects.
 */
function projectResult(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(projectResult);
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value) ? Number(value) : null;
  if (t === 'boolean') return Boolean(value);
  if (t === 'string') return String(value);
  if (t !== 'object') return String(value);
  const out = Object.create(null);
  for (const k of Object.keys(value)) out[String(k)] = projectResult(value[k]);
  return out;
}

const TRADE_FIELDS = [
  'market_id', 'side', 'size', 'entry_px', 'exit_px', 'pnl', 'fees',
  'opened_ms', 'closed_ms', 'how', 'outcome',
];
// Generic market fields, selected when a row carries a label.
// Keep in sync with GENERIC_TRADE_FIELDS in otharness.py.
const GENERIC_TRADE_FIELDS = [
  ...TRADE_FIELDS, 'label', 'mark_px', 'marked_size', 'marked_pnl', 'mark_source',
  'mark_ts_ms', 'mark_age_ms', 'mark_missing',
];
const FILL_FIELDS = [
  'ts_ms', 'market_id', 'side', 'action', 'requested', 'filled', 'unfilled',
  'avg_px', 'worst_px', 'quoted_px', 'levels_walked', 'fee', 'realised', 'tag',
  'liquidity', 'order_id', 'queue_ahead_at_join', 'queue_ahead_at_fill', 'time_in_queue_ms',
  'markout_1s', 'markout_10s', 'markout_60s', 'markout_settle',
];
const GENERIC_FILL_FIELDS = [...FILL_FIELDS, 'label'];

/**
 * Read newline-framed input synchronously as replay requests each line.
 * The reader buffers 64 KiB chunks that may contain later rows, but does not
 * decode a full market before replay. Captured parsing and protected built-ins
 * prevent strategies from intercepting buffered input. Synchronous reads avoid
 * an await per event in the replay loop.
 */
function syncLineReader(fd) {
  const CHUNK = 1 << 16;
  const buf = Buffer.allocUnsafe(CHUNK);
  let pending = '';
  let queue = [];
  let at = 0;
  let eof = false;

  return function next() {
    for (;;) {
      if (at < queue.length) return queue[at++];
      queue = [];
      at = 0;
      if (eof) return null;

      let n = 0;
      try {
        n = readSync(fd, buf, 0, CHUNK, null);
      } catch (err) {
        // A pipe that Node has put into non-blocking mode has nothing ready
        // yet. Spin rather than fail, the worker is still writing.
        if (err.code === 'EAGAIN') continue;
        if (err.code === 'EOF') n = 0;
        else throw err;
      }

      if (n === 0) {
        eof = true;
        if (pending) {
          const last = pending;
          pending = '';
          return last;
        }
        return null;
      }
      pending += buf.toString('utf8', 0, n);
      const parts = pending.split('\n');
      pending = parts.pop();
      queue = parts;
    }
  };
}

/**
 * Load the class named in the manifest without class discovery.
 */
async function loadStrategy(dir, entry) {
  const file = path.join(dir, entry.file);
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (err) {
    throw new RunAbort('E_ENTRY', `could not load ${entry.file}: ${err.message}`);
  }
  const Klass = mod[entry.className] ?? (mod.default?.name === entry.className ? mod.default : undefined);
  if (typeof Klass !== 'function') {
    const exported = Object.keys(mod).filter((k) => k !== 'default');
    throw new RunAbort('E_ENTRY',
      `${entry.file} does not export a class named ${entry.className}`
      + (exported.length ? `; it exports ${exported.join(', ')}` : ''));
  }
  return Klass;
}

/**
 * Validate declared hooks and their arity before replay.
 */
function checkHooks(Klass, hooks, arities) {
  const proto = Klass.prototype;
  for (const [canonical, name] of Object.entries(hooks)) {
    const fn = proto?.[name];
    if (typeof fn !== 'function') {
      throw new RunAbort('E_HOOK_SIG', `${canonical} was declared but ${name}() is not defined on the class`);
    }
    const want = arities[canonical];
    // Arity is advisory in JS, rest params and defaults both report oddly —
    // so only an obviously wrong signature is refused.
    if (want != null && fn.length > want) {
      throw new RunAbort('E_HOOK_SIG',
        `${name}() takes ${fn.length} parameters; ${canonical} is called with ${want - 1} after ctx`);
    }
  }
}

async function main() {
  const jobDir = process.argv[2];
  if (!jobDir) {
    process.stderr.write('usage: harness.mjs <job-dir>   (job on stdin, results on stdout)\n');
    return 2;
  }

  // fd 0 directly, never `process.stdin`: touching the stream API puts the
  // descriptor into non-blocking mode and hands the strategy a global to
  // intercept.
  const nextLine = syncLineReader(0);
  const first = nextLine();
  if (first == null) {
    process.stderr.write('no job on stdin\n');
    return 2;
  }
  const job = parseJson(first);
  const srcDir = path.join(jobDir, 'src');

  // Emit authenticated stdout lines using the key read before strategy import.
  // See protocol.mjs for the protocol and its limits.
  const outputKey = String(job.outputKey ?? '');
  if (!outputKey) {
    process.stderr.write('no output key in the job\n');
    return 2;
  }
  const emit = (channel, payload) => {
    const mac = createHmac('sha256', outputKey).update(`${channel} ${payload}`).digest('hex').slice(0, 32);
    writeSync(RESULT_FD, `${mac} ${channel} ${payload}\n`);
  };
  const logsOut = { write: (text) => emit(CHANNEL.log, text.replace(/\n/g, ' ').trimEnd()) };

  // Execution options (job.engine) and the run-wide order counters they feed.
  const engine = enginePolicy(job);
  const orderStats = engine ? newOrderStats() : null;
  const fillExtras = engineFillFields(engine);

  const result = {
    markets_run: 0,
    events_seen: 0,
    fees_paid: 0,
    log_truncated: false,
    budget: null,
    market_summaries: [],
    crosschecks: [],
    rejection: null,
    // Summed over markets; null when the run could not rest orders at all.
    maker: null,
  };

  // Record per-market samples within run-wide row and byte budgets. Exceeding
  // either discards all recorded series. Keep in sync with otharness.py.
  const record = engine?.record_ms ? { rows: 0, bytes: 0, truncated: false, instance: 0 } : null;
  // Count samples as they are created to bound memory within long markets.
  const recordBudget = record ? { rows: 0, limit: MAX_RECORD_ROWS, truncated: false } : null;
  const emitRecord = (entry, rows) => {
    if (recordBudget.truncated) { record.truncated = true; return; }
    // The instance is the market's place in the run, sent in its header, so a
    // market split across processes still gets the key a single run gives it.
    const key = `${entry.market.market_id}#${Number.isInteger(entry.instance) ? entry.instance : record.instance}`;
    record.instance += 1;
    for (const r of rows ?? []) {
      if (record.truncated) return;
      const payload = stringify(projectRow({ key, ...r }, RECORD_FIELDS));
      const bytes = lineBytes(CHANNEL.record, payload);
      if (record.rows + 1 > MAX_RECORD_ROWS || record.bytes + bytes > MAX_RECORD_BYTES) {
        record.truncated = true;
        return;
      }
      record.rows += 1;
      record.bytes += bytes;
      emit(CHANNEL.record, payload);
    }
  };

  const finish = (code) => {
    result.budget = monitor.summary();
    if (record) result.record = { rows: record.rows, bytes: record.bytes, truncated: record.truncated || recordBudget.truncated };
    if (orderStats) result.orders = orderStats;
    // Project results created after strategy execution to remove inherited hooks.
    emit(CHANNEL.result, stringify(projectResult(result)));
    return code;
  };

  // Use a run-wide monitor and rolling window so cheap earlier events cannot
  // dilute a later phase that exceeds the budget.
  const monitor = new BudgetMonitor({ limitMicros: job.limits?.perEventBudgetMicros ?? 400 });
  // Share one log allowance across all markets.
  const logBudget = makeLogBudget({
    bytes: job.limits?.logBytesPerRun,
    lineChars: job.limits?.logLineChars,
  });

  let Klass;
  try {
    Klass = await loadStrategy(srcDir, job.entry);
    checkHooks(Klass, job.hooks, job.arities ?? {});
  } catch (err) {
    result.rejection = { code: err.code ?? 'E_ENTRY', detail: err.detail ?? String(err?.message ?? err) };
    return finish(EXIT.rejected);
  }

  // Session mode shares one portfolio and one instance across every market;
  // market mode gets a fresh instance per market, which is what lets a run be
  // sharded at all.
  const fees = feePolicy(job);
  const resting = restingPolicy(job);

  const session = job.mode === 'session';
  const shared = session ? new Portfolio({ fees, engine, orderStats }) : null;
  let sharedInstance = null;
  // Global scheduler: the run's clock (MarketReplay `clock`), one for the whole
  // session, one per market otherwise; advanced only by advanceClock.
  const sessionClock = session ? { t: -Infinity } : null;

  /** What the loop tracks for one open market, besides the replay itself. */
  const newMarket = (entry) => {
    // Reference and external-series rows arrive interleaved in event-time order.
    // Append them as replay advances rather than loading full future feed windows.
    const feedRows = new Map();
    const rowsFor = (name) => {
      let a = feedRows.get(name);
      if (!a) { a = []; feedRows.set(name, a); }
      return a;
    };
    return {
      entry,
      replay: null,
      before: null,
      seen: 0,
      // Use the engine's Book to reconstruct both outcomes, sort venue ladders
      // and apply deltas before computing opening quotes.
      summaryBook: new BookCls(),
      // Capture the first state quoting both outcomes, matching the worker.
      // Reading each side at a different instant could change the opening favourite.
      openQuotes: null,
      rowsFor,
      clock: sessionClock ?? { t: -Infinity },
    };
  };

  /**
   * Account for one line of a market's stream. False for a feed row, which is
   * consumed here and never handed to a hook: it is not a market event.
   */
  const observe = (m, ev) => {
    if (ev.kind === 'ref' || ev.kind === 'ext') {
      const row = projectRow(ev, Object.keys(ev).filter((k) => k !== 'kind' && k !== 'name'));
      m.rowsFor(ev.name).push(row);
      return false;
    }
    // A spot value is quiet (DATASETS.spot): not counted as an event seen.
    if (ev.kind !== 'spot') m.seen += 1;
    // Stop maintaining this book once opening quotes are known; replay has its
    // own book. Keep in sync with observe() in runner/harness/python/otharness.py.
    if (ev.kind === 'book' && m.openQuotes === null) {
      if (ev.snapshot) m.summaryBook.snapshot(ev.ts_ms, ev.levels);
      else if (ev.side && ev.ladder) {
        if (ev.mirror === true && m.entry.market?.kind === 'generic') {
          m.summaryBook.deltaMirrored(ev.ts_ms, ev.side, ev.ladder, ev.px, ev.size);
        } else {
          m.summaryBook.delta(ev.ts_ms, ev.side, ev.ladder, ev.px, ev.size);
        }
      }
      const up = m.summaryBook.best('UP');
      const down = m.summaryBook.best('DOWN');
      if (up != null && down != null) m.openQuotes = { up, down };
    }
    return true;
  };

  /** Build a market's replay and open it (on_market_open). */
  const start = (m) => {
    const { entry } = m;
    const pf = shared ?? new Portfolio({ fees, engine, orderStats });
    let instance;
    if (shared) {
      sharedInstance ??= new Klass();
      instance = sharedInstance;
    } else {
      instance = new Klass();
    }
    // Copy params per instance to preserve market-mode independence and sharding.
    instance.p = { ...(job.params ?? {}) };
    m.before = { trades: pf.trades.length, fills: pf.fills.length };
    // The arrays are shared with the stream, so the feeds see each row the
    // moment the replay passes its timestamp, and not before.
    const references = buildFeeds(entry.references ?? [], Object.fromEntries(
      (entry.references ?? []).map((n) => [n, m.rowsFor(n)]),
    ), entry.lags ?? {});
    const series = buildFeeds(entry.series ?? [], Object.fromEntries(
      (entry.series ?? []).map((n) => [n, m.rowsFor(n)]),
    ), entry.lags ?? {});
    m.replay = new MarketReplay({
      market: entry.market,
      stream: entry.stream ?? null,
      spotDeclared: job.spot === true,
      strategy: instance,
      hooks: job.hooks,
      portfolio: pf,
      // Share the run-wide log allowance across markets.
      logBudget,
      fillDelayMs: job.fillDelayMs ?? 0,
      budget: monitor,
      seed: job.seed ?? 1,
      references,
      series,
      resting,
      // Generic markets: the decoder's terminal mark. Lives on the header, not
      // on the market record, and only the replay holds it.
      terminal: entry.terminal ?? null,
      engine,
      clock: m.clock,
      recordBudget,
    });
    m.replay.open(m.openTs ?? null);
  };

  /** Book-keeping once a market has been replayed and settled. */
  const finished = (m, out) => {
    const { entry } = m;
    result.markets_run += 1;
    result.events_seen += m.seen;
    // Acknowledge completed replay, not queued stdin bytes.
    emit(CHANNEL.progress, stringify({ n: result.markets_run }));
    if (out.logTruncated && !result.log_truncated) {
      result.log_truncated = true;
      // Include one truncation notice in the log.
      logsOut.write('[runner] log budget spent — the rest of this run\'s'
        + ' ctx.log output was dropped. ctx.log is for reading, not for'
        + ' exporting; see the SDK docs for the limit.\n');
    }
    // Prefix logs with UTC opening time and a short market id. Omit the time
    // when absent to preserve whitespace-separated fields.
    // Keep in sync with the Python harness.
    const shortId = String(entry.market.market_id ?? '').slice(0, 10);
    // Format opening time to UTC minutes to distinguish it from event epoch ms.
    const openedAt = entry.market.open_ts_ms == null
      ? null
      : new Date(entry.market.open_ts_ms).toISOString().slice(0, 16).replace('T', ' ');
    const prefix = openedAt == null ? shortId : `${openedAt} ${shortId}`;
    for (const line of out.logs) logsOut.write(`${prefix} ${line}\n`);
    for (const c of out.crosschecks) result.crosschecks.push(c);
    if (out.maker) result.maker = addMakerStats(result.maker ?? newMakerStats(), out.maker);
    if (engine?.timers && out.timers) {
      const t = result.timers ?? (result.timers = { created: 0, fired: 0, dropped: 0 });
      for (const k of ['created', 'fired', 'dropped']) t[k] += out.timers[k] ?? 0;
    }
    // The spot dataset: how many markets actually got any (absent unless
    // declared). Keep in sync with otharness.py.
    if (job.spot === true) {
      const s = result.spot ?? (result.spot = { markets: 0, markets_without: 0 });
      if (out.spot_seen > 0) s.markets += 1;
      else s.markets_without += 1;
    }

    // Track observations as they arrive. The worker computes baselines from its
    // own data; these summaries are informational.
    result.market_summaries.push({
      market_id: entry.market.market_id,
      asset: entry.market.asset ?? null,
      interval: entry.market.interval ?? null,
      outcome: entry.market.outcome ?? null,
      up_px: m.openQuotes?.up ?? null,
      down_px: m.openQuotes?.down ?? null,
      stream: entry.stream ?? null,
    });
    if (record && !shared) emitRecord(entry, out.record);
    if (!shared) {
      flush(m.replay.pf, m.before, emit, entry.market.market_id, fillExtras);
      result.fees_paid += m.replay.pf.feesPaid;
    } else {
      // Drain session logs without changing positions or accumulated fees,
      // keeping emitted-row memory bounded.
      flush(shared, { trades: 0, fills: 0 }, emit, true, fillExtras);
    }
  };

  const rejected = (m, err) => {
    const id = m?.entry?.market?.market_id ?? '?';
    if (err instanceof RunAbort) {
      result.rejection = { code: err.code, detail: `${id}: ${err.detail}` };
      // Abort the shard on a budget breach or strategy error.
      if (shared) flush(shared, { trades: 0, fills: 0 }, emit, true, fillExtras);
      else if (m?.replay) flush(m.replay.pf, m.before, emit, id, fillExtras);
      return finish(err.code === 'E_BUDGET' ? EXIT.budget : EXIT.rejected);
    }
    result.rejection = { code: 'E_RUNTIME', detail: `${id}: ${err?.message ?? err}` };
    return finish(EXIT.rejected);
  };

  const global = engine?.scheduler === 'global';
  if (session) {
    const code = runSession({ nextLine, newMarket, observe, start, finished, rejected, logsOut, global });
    if (code != null) return code;
    flush(shared, { trades: 0, fills: 0 }, emit, null, fillExtras);
    result.fees_paid = shared.feesPaid;
    return finish(EXIT.ok);
  }

  // Markets stream in, one at a time, for as long as the worker sends them.
  for (;;) {
    const header = nextLine();
    if (header == null) break;
    let entry;
    try {
      entry = parseJson(header);
    } catch (err) {
      logsOut.write(`[runner] malformed market header: ${err.message}\n`);
      break;
    }
    const m = newMarket(entry);
    m.openTs = entry.market?.open_ts_ms ?? null;
    const remaining = { n: entry.n ?? 0 };
    const one = [{ m, k: 0 }];
    // Global mode: the line's own time, a feed row becomes visible at its
    // stamp plus its declared lag, exactly as the stream ordered it.
    const lineTime = (ev) => ((ev.kind === 'ref' || ev.kind === 'ext')
      ? Number(ev.ts_ms) + (Number(entry.lags?.[ev.name]) || 0) : ev.ts_ms);

    // Pull events as replay requests them without accumulating the market.
    function* eventStream() {
      while (remaining.n > 0) {
        remaining.n -= 1;
        const line = nextLine();
        if (line == null) return;
        let ev;
        try {
          ev = parseJson(line);
        } catch {
          // The worker reconciles malformed archive rows against emitted counts.
          continue;
        }
        if (global) {
          // Nothing past the market's last instant is processed, and every job
          // before this line runs first (feed rows included).
          const t = lineTime(ev);
          if (typeof t === 'number' && t > m.replay.closeTs) { remaining.stop = true; return; }
          runDue(one, t, false);
          advanceClock(m.clock, t);
        }
        if (observe(m, ev)) yield ev;
      }
    }

    /** Drain whatever the replay did not consume, so the stream stays framed. */
    const drainRest = () => {
      while (remaining.n > 0) {
        remaining.n -= 1;
        if (nextLine() == null) return;
      }
    };

    let out;
    try {
      start(m);
      for (const ev of eventStream()) {
        if (!m.replay.step(ev)) break;
      }
      if (global) {
        // Every job up to the last tradable instant (generic: trade_until;
        // archive: the close), then the close itself.
        const r = m.replay;
        const end = r.generic ? r.tradeUntil : (r.declaredClose ?? r.lastTs);
        runDue(one, end, true);
        advanceClock(m.clock, end);
      }
      out = m.replay.close();
    } catch (err) {
      drainRest();
      return rejected(m, err);
    }
    drainRest();
    finished(m, out);
  }

  return finish(EXIT.ok);
}

/**
 * Replay all open markets in shared event-time order.
 *
 * Lines are {"open":{i, market, stream, references?, series?, lags?}},
 * {"i":k,"e":<event>} and {"close":k}, from runner/session-feed.mjs.
 * Keep in sync with _run_session in otharness.py.
 *
 * Return an exit code on early termination, or null at the end of the stream.
 */
function runSession({ nextLine, newMarket, observe, start, finished, rejected, logsOut, global = false }) {
  const active = new Map();
  // Generic markets whose trading has ended and whose settlement is still to
  // come (`{"end":k}` then, later, `{"close":k}`). Out of `active`: nothing
  // reaches them in between, and settleEarlier has nothing of theirs to drain.
  const ending = new Map();
  // Before a hook at ts, drain strictly earlier work in every open market
  // against its current book. Hooks see prior fills across the shared portfolio.
  const settleEarlier = (except, ts) => {
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return;
    for (const other of active.values()) {
      if (other !== except && !other.replay.ended) other.replay.drainUntil(ts - 1);
    }
  };
  for (;;) {
    const line = nextLine();
    if (line == null) break;
    let msg;
    try {
      msg = parseJson(line);
    } catch (err) {
      logsOut.write(`[runner] malformed session line: ${err.message}\n`);
      break;
    }
    if (!msg || typeof msg !== 'object') continue;
    if (global) {
      // Phase 2b: one time line. The stream says when each line happens (t);
      // every job strictly before it, in every market, in (at, rank, market,
      // seq) order, runs first; end and close also run the jobs at their time.
      const code = sessionGlobal(msg, { active, ending, newMarket, observe, start, finished, rejected });
      if (code !== undefined) return code;
      continue;
    }
    if (msg.open) {
      const m = newMarket(msg.open);
      try {
        settleEarlier(null, msg.open.market?.open_ts_ms);
        active.set(msg.open.i, m);
        start(m);
      } catch (err) { return rejected(m, err); }
      continue;
    }
    if (msg.end != null) {
      const m = active.get(msg.end);
      if (!m) continue;
      try {
        settleEarlier(m, m.replay.tradeUntil);
        active.delete(msg.end);
        ending.set(msg.end, m);
        m.replay.endTrading();
      } catch (err) { return rejected(m, err); }
      continue;
    }
    if (msg.close != null) {
      const m = active.get(msg.close) ?? ending.get(msg.close);
      if (!m) continue;
      let out;
      try {
        // The instant it settles at: its declared close, or the last event it
        // saw when it has none (MarketReplay.close uses the same).
        settleEarlier(m, m.replay.declaredClose ?? m.replay.lastTs);
        active.delete(msg.close);
        ending.delete(msg.close);
        out = m.replay.close();
      } catch (err) { return rejected(m, err); }
      finished(m, out);
      continue;
    }
    const m = active.get(msg.i);
    const ev = msg.e;
    if (!m || !ev || typeof ev !== 'object') continue;
    if (!observe(m, ev)) continue;
    try {
      settleEarlier(m, ev.ts_ms);
      m.replay.step(ev);
    } catch (err) {
      return rejected(m, err);
    }
  }
  // A stream that ended with markets still open was cut short; close them so
  // what did happen is reported, and the worker's count catches the rest.
  for (const m of [...active.values(), ...ending.values()]) {
    let out;
    try { out = m.replay.close(); } catch (err) { return rejected(m, err); }
    finished(m, out);
  }
  return null;
}

/**
 * Run every job due before `t` (or at it, `inclusive`) across `markets`
 * ([{m, k}]), one at a time, always the globally earliest by (at, rank, k,
 * seq), re-scanning after each, because a job can create jobs. Keep in sync with
 * run_due in otharness.py.
 */
function runDue(markets, t, inclusive) {
  if (typeof t !== 'number' || Number.isNaN(t)) return;
  for (;;) {
    let best = null;
    for (const x of markets) {
      const d = x.m.replay?.nextDue?.();
      if (!d || (inclusive ? d.at > t : d.at >= t)) continue;
      if (!best || d.at < best.d.at || (d.at === best.d.at && (d.rank < best.d.rank
        || (d.rank === best.d.rank && (x.k < best.x.k || (x.k === best.x.k && d.seq < best.d.seq)))))) {
        best = { d, x };
      }
    }
    if (!best) return;
    advanceClock(best.x.m.clock, best.d.at);
    best.x.m.replay.runOne();
  }
}

/** The run has reached `t`: nothing may be filed or run before it now. Keep in sync with advance_clock. */
function advanceClock(clock, t) {
  if (clock && typeof t === 'number' && t > clock.t) clock.t = t;
}

/** One session line under the global scheduler. Returns an exit code to stop, else undefined. */
function sessionGlobal(msg, { active, ending, newMarket, observe, start, finished, rejected }) {
  const all = () => [...[...active].map(([k, m]) => ({ m, k })), ...[...ending].map(([k, m]) => ({ m, k }))];
  const t = typeof msg.t === 'number' ? msg.t : null;
  const guard = (m, fn) => { try { fn(); return undefined; } catch (err) { return rejected(m, err); } };
  if (msg.open) {
    const m = newMarket(msg.open);
    m.openTs = t;
    return guard(m, () => {
      if (t != null) runDue(all(), t, false);
      advanceClock(m.clock, t);
      active.set(msg.open.i, m);
      start(m);
    });
  }
  if (msg.end != null) {
    const m = active.get(msg.end);
    if (!m) return undefined;
    return guard(m, () => {
      runDue(all(), t ?? m.replay.tradeUntil, true);
      advanceClock(m.clock, t ?? m.replay.tradeUntil);
      active.delete(msg.end);
      ending.set(msg.end, m);
      m.replay.endTrading();
    });
  }
  if (msg.close != null) {
    const m = active.get(msg.close) ?? ending.get(msg.close);
    if (!m) return undefined;
    let out;
    const code = guard(m, () => {
      runDue(all(), t ?? m.replay.declaredClose ?? m.replay.lastTs, true);
      advanceClock(m.clock, t ?? m.replay.declaredClose ?? m.replay.lastTs);
      active.delete(msg.close);
      ending.delete(msg.close);
      out = m.replay.close(t);
    });
    if (code !== undefined) return code;
    finished(m, out);
    return undefined;
  }
  const m = active.get(msg.i);
  const ev = msg.e;
  if (!m || !ev || typeof ev !== 'object') return undefined;
  return guard(m, () => {
    if (t != null) runDue(all(), t, false);
    advanceClock(m.clock, t);
    if (observe(m, ev)) m.replay.step(ev);
  });
}

/**
 * The run's fee policy: `job.fees` when the writer sent one, else the legacy
 * flat `feeBps`. Keep in sync with fee_policy in otharness.py.
 */
function feePolicy(job) {
  const f = job.fees;
  if (f && typeof f === 'object' && (f.mode === 'venue' || f.mode === 'bps')) return f;
  return { mode: 'bps', bps: job.feeBps ?? 0 };
}

/**
 * The run's execution options (enginePolicyFor), or null. Anything malformed is
 * null, every option off, the fail-closed direction for options that only
 * ever add rules. Keep in sync with engine_policy in otharness.py.
 */
function enginePolicy(job) {
  const e = job.engine;
  return e && typeof e === 'object' && !Array.isArray(e) ? e : null;
}

/**
 * The fill-row fields the run's options can produce, in column order. Fixed
 * per run, before any row exists, so every writer (the worker's streaming
 * fills.csv included) knows its columns up front. Keep in sync with
 * engine_fill_fields in otharness.py and fillColumnsFor in runner/archive.mjs.
 */
function engineFillFields(engine) {
  if (!engine) return [];
  const out = [];
  if (engine.fok || engine.order_rules || engine.quote_guard) out.push('reject_reason');
  if (engine.maker_rebate != null) out.push('rebate');
  return out;
}

/**
 * The run's resting-order policy, as the writer decided it (restingPolicyFor in
 * api/lib/backtest-datasets.mjs). Anything malformed is "not allowed", the
 * fail-closed direction. Keep in sync with resting_policy in otharness.py.
 */
function restingPolicy(job) {
  const r = job.resting;
  if (!r || typeof r !== 'object') {
    return { allowed: false, refusal: 'resting (gtc) orders are not available for this run', cancelLatencyMs: 0 };
  }
  return {
    allowed: r.allowed === true,
    refusal: typeof r.refusal === 'string' ? r.refusal : 'resting (gtc) orders are not available for this run',
    cancelLatencyMs: Number.isFinite(r.cancelLatencyMs) && r.cancelLatencyMs >= 0 ? r.cancelLatencyMs : (job.fillDelayMs ?? 0),
  };
}

/** Write everything a market added to the two logs. */
function flush(pf, before, emit, marketId, fillExtras = []) {
  for (let i = before.trades; i < pf.trades.length; i += 1) {
    const row = pf.trades[i];
    emit(CHANNEL.trade, stringify(projectRow(row, row.label !== undefined ? GENERIC_TRADE_FIELDS : TRADE_FIELDS)));
  }
  // A session drain (marketId === true) happens whenever a market closes, so
  // it can meet maker rows of a market still open, whose markouts are not
  // final yet. Those stay behind, in order, until their own market's close.
  const held = [];
  for (let i = before.fills; i < pf.fills.length; i += 1) {
    const row = pf.fills[i];
    if (marketId === true && rowPending(row)) { held.push(row); continue; }
    const base = row.label !== undefined ? GENERIC_FILL_FIELDS : FILL_FIELDS;
    emit(CHANNEL.fill, stringify(projectRow(row, fillExtras.length ? [...base, ...fillExtras] : base)));
  }
  // Release emitted rows to keep memory bounded across market-days.
  if (marketId) {
    pf.trades.length = before.trades;
    pf.fills.length = before.fills;
    for (const row of held) pf.fills.push(row);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exit(1);
  });
