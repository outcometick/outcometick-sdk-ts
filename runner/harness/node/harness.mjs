#!/usr/bin/env node
// The Node.js harness. Runs INSIDE the sandbox, in the same process as the
// submitted strategy.
//
// It is the strategy's whole world: the SDK surface it imports, the loop that
// calls it, and the only two things it can write. There is no network stack in
// the image and the filesystem is read-only apart from one scratch directory,
// so this file does not try to be a security boundary — the container is. What
// it does enforce is the CONTRACT: hooks are called with the right shapes, the
// per-event budget is measured, and nothing but trades, fills and logs comes
// back out.
//
//   node harness.mjs <job-dir>      job on stdin, results on stdout

import { readSync, writeSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { replayMarket, makeLogBudget, BudgetMonitor, RunAbort } from '../../engine/replay.mjs';
import { Book as BookCls } from '../../engine/book.mjs';
import { buildFeeds } from '../../engine/feed.mjs';
import { Portfolio } from '../../engine/portfolio.mjs';
import { CHANNEL, RESULT_FD, EXIT } from '../protocol.mjs';

/**
 * REPLACE `console`, before any strategy code is imported. Do not patch it.
 *
 * fd 1 is the result channel now (see protocol.mjs), and Node exposes no dup2,
 * so it cannot be repointed the way the Python harness repoints it. Swapping
 * out the METHODS is not enough: Node's console keeps the underlying stream on
 * `console._stdout`, and `console.Console` will build a fresh one over any
 * stream handed to it. `console._stdout.write(...)` passes the analyser today
 * and puts arbitrary bytes on the result channel — not a forgery, the MAC still
 * holds, but a half-line written between two real ones corrupts the record that
 * follows it, and a dropped result reads as a run that produced nothing and
 * gets refunded.
 *
 * So the strategy gets an object that holds no stream at all. Silently dropped
 * rather than redirected: ctx.log is the documented, bounded, archived channel,
 * and a strategy printing megabytes should not be able to turn that into worker
 * output.
 */
let warnedAboutConsole = false;
function consoleIsGone() {
  // Not silent: a strategy author whose console.log vanishes without a word
  // will spend an afternoon on it. stderr is the harness's own channel, and
  // `ot run` prints it.
  if (warnedAboutConsole) return undefined;
  warnedAboutConsole = true;
  try {
    writeSync(2, 'harness: console output is discarded — use ctx.log() instead\n');
  } catch { /* stderr is not worth crashing a run over */ }
  return undefined;
}
globalThis.console = Object.freeze(Object.fromEntries(
  // Every method the platform documents, so a strategy calling a real one gets
  // a no-op instead of a TypeError. Deliberately absent: _stdout, _stderr and
  // Console — the three names that hand back a writable stream.
  [
    'assert', 'clear', 'count', 'countReset', 'debug', 'dir', 'dirxml', 'error',
    'group', 'groupCollapsed', 'groupEnd', 'info', 'log', 'profile',
    'profileEnd', 'table', 'time', 'timeEnd', 'timeLog', 'timeStamp', 'trace',
    'warn',
  ].map((m) => [m, consoleIsGone]),
));


/**
 * The parser, captured at module load — before any strategy is imported.
 *
 * Defence in depth behind the streaming fix below: even reading one event at a
 * time, a strategy that had replaced `JSON.parse` would see each row a moment
 * before its own hook does. Capturing costs nothing.
 */
const parseJson = JSON.parse;

/**
 * Our own JSON writer. `JSON.stringify` is not used for output at all.
 *
 * Capturing `JSON.stringify` at module load is not enough, and neither is
 * projecting rows onto null-prototype objects. `JSON.stringify` looks up
 * `toJSON` through the PROTOTYPE CHAIN — on arrays, and even on primitives via
 * boxing — so a single `Object.prototype.toJSON = …` compromises it no matter
 * what it is handed. (Deleting the property is not a fix either: a strategy can
 * define it non-configurable.)
 *
 * Thirty lines of writer sidesteps the entire question: nothing here consults a
 * prototype, so there is nothing to poison. The shapes are simple — numbers,
 * strings, booleans, nulls, arrays and flat objects — because that is all the
 * protocol allows out.
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
 * Copy a row onto a NULL-PROTOTYPE object with primitive-coerced values.
 *
 * A captured stringify still consults `toJSON` on the value it is given, and
 * `Object.prototype.toJSON = …` would reach every ordinary object. A
 * null-prototype object inherits nothing, so there is no hook to install, and
 * coercing each field means a getter cannot be smuggled in either.
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
 * Deep-copy the result onto null-prototype objects.
 *
 * Same reasoning as projectRow, applied to the whole document: nothing that
 * inherits from Object.prototype survives, so there is no toJSON hook to
 * install anywhere in the tree.
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
const FILL_FIELDS = [
  'ts_ms', 'market_id', 'side', 'action', 'requested', 'filled', 'unfilled',
  'avg_px', 'worst_px', 'quoted_px', 'levels_walked', 'fee', 'realised', 'tag',
];

/**
 * Pull lines off a file descriptor SYNCHRONOUSLY, one at a time.
 *
 * Synchronous, and reading only as far as it is asked to, because that is what
 * makes the product's central claim literally true rather than approximately
 * true. The docs say:
 *
 *     Look-ahead is impossible, because future rows are not in the process
 *     yet — not filtered out, not present.
 *
 * The previous version buffered a whole market's events into an array before
 * replay started. The future WAS in the process, and the strategy — imported
 * before that buffering — only had to intercept something the harness used to
 * fill it. `JSON.parse = …` and `Array.prototype.push = …` both pass static
 * analysis, and either one hands the strategy every tick of the market before
 * its first hook fires. It could then trade on data it should not have, and the
 * engine would execute those orders for real: not a forged report, a genuinely
 * computed one that means nothing.
 *
 * Pulling one line at a time, driven by the replay loop, removes the thing
 * being stolen. An intercepted parser now sees exactly the event the strategy
 * is about to be handed anyway.
 *
 * Sync rather than async so the replay loop stays a plain `for…of`: an
 * `await` per event across hundreds of millions of events is a real cost, and
 * this runs inside a 400µs-per-event budget.
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
        // yet. Spin rather than fail — the worker is still writing.
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
 * Load the strategy class the manifest named.
 *
 * By exact name, with no discovery. A module that exports one class under a
 * different name is a rejection rather than a guess: guessing is how a run
 * silently executes something other than what the submitter meant.
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
 * Check the declared hooks exist with the right arity before anything runs.
 *
 * A declared-but-missing hook is a rejection, and finding that out now costs
 * nothing — finding it out after 700 market-days have been decoded costs the
 * customer a run.
 */
function checkHooks(Klass, hooks, arities) {
  const proto = Klass.prototype;
  for (const [canonical, name] of Object.entries(hooks)) {
    const fn = proto?.[name];
    if (typeof fn !== 'function') {
      throw new RunAbort('E_HOOK_SIG', `${canonical} was declared but ${name}() is not defined on the class`);
    }
    const want = arities[canonical];
    // Arity is advisory in JS — rest params and defaults both report oddly —
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

  // Every result line goes out over stdout, authenticated with the per-run key
  // that arrived in the job — before any strategy was imported. See the long
  // note in protocol.mjs: /out used to be a writable mount, and an allowlisted
  // pandas could rewrite trades.jsonl from on_settle.
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

  const result = {
    markets_run: 0,
    events_seen: 0,
    fees_paid: 0,
    log_truncated: false,
    budget: null,
    market_summaries: [],
    crosschecks: [],
    rejection: null,
  };

  const finish = (code) => {
    result.budget = monitor.summary();
    // Projected like the rows: `result` is an ordinary object built AFTER
    // untrusted code has run, and Object.prototype.toJSON reaches every
    // ordinary object — so a captured stringify alone still let a strategy
    // forge markets_run, fees_paid, crosschecks and the budget summary.
    emit(CHANNEL.result, stringify(projectResult(result)));
    return code;
  };

  // One monitor across the whole run: resetting it per market would let a
  // strategy be pathological on every market and never trip. That is also
  // exactly why the verdict is a WINDOW rather than a lifetime mean — spanning
  // the run means a cheap prefix would otherwise pay for an expensive phase.
  const monitor = new BudgetMonitor({ limitMicros: job.limits?.perEventBudgetMicros ?? 400 });
  // ONE log allowance for the whole run. Every market gets the same object, so
  // a strategy cannot multiply its budget by the number of markets in a day —
  // which on polymarket is about 386.
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
  const shared = job.mode === 'session' ? new Portfolio({ feeBps: job.feeBps ?? 0 }) : null;
  let sharedInstance = null;

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

    // The market's events, pulled ONE AT A TIME as the replay loop asks for
    // them. Nothing here holds more than the current row, which is the whole
    // point — see syncLineReader above.
    let seenEvents = 0;
    // The book as the ENGINE sees it, advanced by the same class.
    //
    // Three things were wrong with reading the last book event instead. A
    // Polymarket snapshot carries one side, so the other came back null. Its
    // ask ladder is published descending while Predict's is ascending, so
    // element zero was the worst offer on one venue. And a `price_change`
    // after the last snapshot moved the price for the engine but not for this
    // number. Advancing a real Book removes all three, and removes a second
    // implementation with them.
    const summaryBook = new BookCls();
    // The first book state that quotes BOTH sides — the same rule the worker
    // applies, so the two do not report different numbers for one run. Locking
    // each side as it appears would mix prices from two instants, and the
    // favourite is the dearer of the pair.
    let openQuotes = null;
    const remaining = { n: entry.n ?? 0 };

    // Reference feeds and user series arrive INTERLEAVED in the same stream,
    // in event time, and are appended to a growing array as they pass.
    //
    // Not shipped as a block on the market header, which would be simpler:
    // a Binance price is very nearly the underlying that decides the outcome,
    // so holding the whole window in the process would reopen exactly the hole
    // the event stream was hardened against — a strategy that patched
    // JSON.parse at import time could read the future off it. Streaming keeps
    // the guarantee structural: a row the replay has not reached is not in the
    // process at all.
    const feedRows = new Map();
    const rowsFor = (name) => {
      let a = feedRows.get(name);
      if (!a) { a = []; feedRows.set(name, a); }
      return a;
    };

    function* eventStream() {
      while (remaining.n > 0) {
        remaining.n -= 1;
        const line = nextLine();
        if (line == null) return;
        let ev;
        try {
          ev = parseJson(line);
        } catch {
          // A corrupt row in OUR OWN data is not the strategy's problem. The
          // worker reconciles what it sent against what came back.
          continue;
        }
        // Consumed here, never handed to a hook: these are not market events.
        if (ev.kind === 'ref' || ev.kind === 'ext') {
          const row = projectRow(ev, Object.keys(ev).filter((k) => k !== 'kind' && k !== 'name'));
          rowsFor(ev.name).push(row);
          continue;
        }
        seenEvents += 1;
        if (ev.kind === 'book') {
          if (ev.snapshot) summaryBook.snapshot(ev.ts_ms, ev.levels);
          else if (ev.side && ev.ladder) {
            summaryBook.delta(ev.ts_ms, ev.side, ev.ladder, ev.px, ev.size);
          }
          if (openQuotes === null) {
            const up = summaryBook.best('UP');
            const down = summaryBook.best('DOWN');
            if (up != null && down != null) openQuotes = { up, down };
          }
        }
        yield ev;
      }
    }

    // The arrays are shared with the stream above, so the feeds see each row
    // the moment the replay passes its timestamp — and not before.
    const references = buildFeeds(entry.references ?? [], Object.fromEntries(
      (entry.references ?? []).map((n) => [n, rowsFor(n)]),
    ), entry.lags ?? {});
    const series = buildFeeds(entry.series ?? [], Object.fromEntries(
      (entry.series ?? []).map((n) => [n, rowsFor(n)]),
    ), entry.lags ?? {});

    /** Drain whatever the replay did not consume, so the stream stays framed. */
    const drainRest = () => {
      while (remaining.n > 0) {
        remaining.n -= 1;
        if (nextLine() == null) return;
      }
    };

    const pf = shared ?? new Portfolio({ feeBps: job.feeBps ?? 0 });
    let instance;
    if (shared) {
      sharedInstance ??= new Klass();
      instance = sharedInstance;
    } else {
      instance = new Klass();
    }
    // A fresh copy per instance. Sharing one object across markets let a
    // strategy that wrote to ctx.p in market 1 change its own behaviour in
    // market 2 — which is exactly the cross-market state that per-market
    // reset exists to prevent, and it would break sharding silently.
    instance.p = { ...(job.params ?? {}) };

    const before = { trades: pf.trades.length, fills: pf.fills.length };

    try {
      const out = replayMarket({
        market: entry.market,
        events: eventStream(),
        strategy: instance,
        hooks: job.hooks,
        portfolio: pf,
        // ONE allowance for the whole run, handed to every market. Per-market
        // was the old shape and the reason ctx.log was an export channel.
        logBudget,
        fillDelayMs: job.fillDelayMs ?? 0,
        logLimit: job.limits?.logLinesPerMarketDay ?? 10_000,
        budget: monitor,
        seed: job.seed ?? 1,
        feeBps: job.feeBps ?? 0,
        references,
        series,
      });

      drainRest();
      result.markets_run += 1;
      result.events_seen += seenEvents;
      // Acknowledge the market-day AFTER it is replayed, so the panel a
      // customer is watching counts finished work rather than queued bytes.
      emit(CHANNEL.progress, stringify({ n: result.markets_run }));
      if (out.logTruncated && !result.log_truncated) {
        result.log_truncated = true;
        // SAID IN THE LOG ITSELF, once, where someone reading it will see it.
        // A log that just stops looks like a strategy that stopped calling
        // ctx.log — and the reader goes hunting for a bug in their own code.
        logsOut.write('[runner] log budget spent — the rest of this run\'s'
          + ' ctx.log output was dropped. ctx.log is for reading, not for'
          + ' exporting; see the SDK docs for the limit.\n');
      }
      for (const line of out.logs) logsOut.write(`${entry.market.market_id} ${line}\n`);
      for (const c of out.crosschecks) result.crosschecks.push(c);

      // Tracked as the stream went past rather than scanned afterwards: there
      // is no array left to scan, which is the point. The worker prices the
      // report's baselines from its OWN copy anyway; this is informational.
      result.market_summaries.push({
        market_id: entry.market.market_id,
        asset: entry.market.asset ?? null,
        interval: entry.market.interval ?? null,
        outcome: entry.market.outcome ?? null,
        up_px: openQuotes?.up ?? null,
        down_px: openQuotes?.down ?? null,
        stream: entry.stream ?? null,
      });
    } catch (err) {
      drainRest();
      if (err instanceof RunAbort) {
        result.rejection = { code: err.code, detail: `${entry.market.market_id}: ${err.detail}` };
        // A budget breach kills the shard, and a strategy that throws is not
        // going to stop throwing on the next market. Either way the run is
        // over and nothing is billed.
        flush(pf, before, emit, entry.market.market_id);
        return finish(err.code === 'E_BUDGET' ? EXIT.budget : EXIT.rejected);
      }
      result.rejection = { code: 'E_RUNTIME', detail: `${entry.market.market_id}: ${err?.message ?? err}` };
      return finish(EXIT.rejected);
    }

    if (!shared) {
      flush(pf, before, emit, entry.market.market_id);
      result.fees_paid += pf.feesPaid;
    }
  }

  if (shared) {
    flush(shared, { trades: 0, fills: 0 }, emit, null);
    result.fees_paid = shared.feesPaid;
  }

  return finish(EXIT.ok);
}

/** Write everything a market added to the two logs. */
function flush(pf, before, emit, marketId) {
  for (let i = before.trades; i < pf.trades.length; i += 1) {
    emit(CHANNEL.trade, stringify(projectRow(pf.trades[i], TRADE_FIELDS)));
  }
  for (let i = before.fills; i < pf.fills.length; i += 1) {
    emit(CHANNEL.fill, stringify(projectRow(pf.fills[i], FILL_FIELDS)));
  }
  // Keep memory flat across hundreds of market-days: once written, the rows
  // are the worker's problem, not ours.
  if (marketId) {
    pf.trades.length = before.trades;
    pf.fills.length = before.fills;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exit(1);
  });
