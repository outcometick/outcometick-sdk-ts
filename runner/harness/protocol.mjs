// The contract between the worker (outside the sandbox) and a harness (inside).
//
// The worker never trusts anything a harness writes: it validates the shape,
// bounds every array, and recomputes the report itself from the trade and fill
// logs. A harness runs in the same process as untrusted code, so its output is
// untrusted output — the container is the boundary, not the harness.
//
import { createHmac, timingSafeEqual } from 'node:crypto';

// This is also the reason the REPORT is not computed inside. Metrics,
// calibration, latency and slippage are all derived outside, in one shared
// implementation, from the two logs below. A Python run and a Node run
// therefore cannot produce differently-shaped reports even though they run
// different engines.

/**
 * The job reaches the harness on STDIN, not as a file.
 *
 * It used to be written to /job/job.json and the events to a mounted /events.
 * The static analysers forbid `open`, `os` and `pathlib`, but the allowlisted
 * dependencies read files perfectly well — `pandas.read_json('/job/job.json')`
 * needs none of them. That handed a strategy every market's settled outcome and
 * the path to every event file, i.e. the whole future. Look-ahead being
 * impossible is the one claim this product cannot lose.
 *
 * stdin is reachable in neither language without `process` (JS) or `sys`
 * (Python), both of which the analysers refuse. Nothing with a future fact in it
 * touches a path the strategy can open.
 *
 * The stream is newline-framed:
 *
 *   <job json>
 *   {"market": {...}, "n": <count>}
 *   <event json>            x count
 *   {"market": {...}, "n": <count>}
 *   ...
 *
 * Markets arrive one at a time so the harness's memory stays flat across a
 * seven-hundred-market-day run, exactly as it did when reading files.
 */
export const JOB_FILE = 'job.json';

/**
 * Results come back over stdout, authenticated. There is no output directory.
 *
 * `/out` used to be a writable bind mount holding trades.jsonl and fills.jsonl.
 * A Python strategy declaring the allowlisted `pandas` could call
 * `DataFrame.to_json('/out/trades.jsonl')` from `on_settle` — that is, AFTER
 * being told the official outcome — and write profitable trades with valid
 * market ids and in-window timestamps. It needed no analyser bypass at all, and
 * reconcileRows cannot tell a forged row from an engine one: it checks that the
 * market existed, not that the fill happened.
 *
 * Two changes, and both are needed:
 *
 *  1. Output is a PIPE, not a file. Rows already sent cannot be unsent, so a
 *     strategy cannot delete its losses either — which an HMAC alone would not
 *     have stopped.
 *  2. Every line is MACed with a per-run key that arrives on stdin and is
 *     consumed before user code is imported. It never touches a filesystem, so
 *     writing to `/proc/self/fd/3` — which IS addressable, a pipe is not by
 *     itself enough — produces lines the worker drops.
 *
 * This does not defeat a strategy that achieves full code execution and digs
 * the key out of a closure. It does defeat "declare pandas and write a file",
 * which was the actual, verified hole.
 *
 * Line format:  <mac> <channel> <payload>
 */
export const CHANNEL = Object.freeze({
  trade: 't',
  fill: 'f',
  log: 'l',
  result: 'r',
  /**
   * "I have finished replaying market-day N." Display only.
   *
   * The worker used to count how many market-days it had WRITTEN into stdin,
   * which is not the same thing: a write only proves the bytes were accepted
   * into a buffer. Small days fit several at a time, so the bar ran ahead of
   * the replay and could show 100% while the sandbox still had work to do —
   * the "looks stuck" experience this panel exists to prevent.
   *
   * It comes from the sandbox, so it is attacker-influenced like every other
   * line, and it is authenticated like every other line. That is fine for a
   * progress bar and NOT fine for money: billing still uses only what the
   * worker itself fetched and fed.
   */
  progress: 'p',
});

/**
 * The authenticated result channel: the container's stdout.
 *
 * It used to be fd 3. Docker hands a container stdin/stdout/stderr and nothing
 * else — the worker spawns `docker run` with a fourth pipe, but that fd belongs
 * to the docker CLIENT, so inside the container fd 3 was closed and every write
 * failed with EBADF. No containerised run had ever produced a result.
 *
 * Each harness makes fd 1 unreachable for the strategy before loading its code
 * (Python dups it away and points 1 at /dev/null; JavaScript takes over
 * `console`, which is the only route left once the analyser has refused
 * `process`). The MAC is what makes forgery impossible, and always was —
 * /proc/self/fd/1 was addressable either way.
 */
export const RESULT_FD = 1;

/** Exit codes a harness may use. Anything else is treated as a crash. */
export const EXIT = Object.freeze({
  ok: 0,
  /** The strategy or the manifest is wrong — a rejection, and free. */
  rejected: 10,
  /** The strategy exceeded a limit. Also free: no report was produced. */
  budget: 11,
});

/** Fields a trade row must carry. A row missing any of them is dropped. */
export const TRADE_FIELDS = Object.freeze([
  'market_id', 'side', 'size', 'entry_px', 'exit_px', 'pnl', 'fees',
  'opened_ms', 'closed_ms', 'how',
]);

export const FILL_FIELDS = Object.freeze([
  'ts_ms', 'market_id', 'side', 'action', 'requested', 'filled', 'unfilled',
  'avg_px', 'worst_px', 'quoted_px', 'levels_walked', 'fee', 'realised',
]);

const finite = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Validate one trade row from a harness.
 *
 * Returns the row narrowed to known fields, or null. Dropping rather than
 * throwing: one malformed row out of a hundred thousand should cost that row,
 * not the customer's whole run — and the count of dropped rows is reported so
 * it cannot be silent.
 */
export function parseTrade(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.market_id !== 'string' || !raw.market_id) return null;
  if (raw.side !== 'UP' && raw.side !== 'DOWN') return null;
  if (!finite(raw.size) || raw.size < 0) return null;
  if (!finite(raw.pnl)) return null;
  const px = (v) => (v == null ? null : (finite(v) && v >= 0 && v <= 1 ? v : undefined));
  const entry = px(raw.entry_px);
  const exit = px(raw.exit_px);
  // `undefined` means a value was present but impossible — a price outside
  // 0..1 is not a price on a binary market, and accepting it would put a
  // fabricated number into the calibration panel.
  if (entry === undefined || exit === undefined) return null;
  return {
    market_id: raw.market_id,
    side: raw.side,
    size: raw.size,
    entry_px: entry,
    exit_px: exit,
    pnl: raw.pnl,
    fees: finite(raw.fees) ? raw.fees : 0,
    opened_ms: finite(raw.opened_ms) ? raw.opened_ms : null,
    closed_ms: finite(raw.closed_ms) ? raw.closed_ms : null,
    how: typeof raw.how === 'string' ? raw.how : 'exit',
    outcome: raw.outcome === 'UP' || raw.outcome === 'DOWN' ? raw.outcome : undefined,
  };
}

export function parseFill(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.market_id !== 'string' || !raw.market_id) return null;
  if (raw.side !== 'UP' && raw.side !== 'DOWN') return null;
  if (!finite(raw.requested) || !finite(raw.filled)) return null;
  const px = (v) => (v == null ? null : (finite(v) ? v : null));
  return {
    ts_ms: finite(raw.ts_ms) ? raw.ts_ms : null,
    market_id: raw.market_id,
    side: raw.side,
    action: raw.action === 'reduce' ? 'reduce' : 'open',
    requested: raw.requested,
    filled: raw.filled,
    unfilled: finite(raw.unfilled) ? raw.unfilled : Math.max(0, raw.requested - raw.filled),
    avg_px: px(raw.avg_px),
    worst_px: px(raw.worst_px),
    quoted_px: px(raw.quoted_px),
    levels_walked: finite(raw.levels_walked) ? raw.levels_walked : 0,
    fee: finite(raw.fee) ? raw.fee : 0,
    realised: finite(raw.realised) ? raw.realised : 0,
    tag: typeof raw.tag === 'string' ? raw.tag.slice(0, 64) : null,
  };
}

/**
 * Parse a JSONL log from a harness, bounded.
 *
 * `maxRows` is a hard stop, not a suggestion: a harness that emits rows in a
 * loop must not be able to exhaust the worker's memory from inside the
 * sandbox. What was dropped is returned, never swallowed.
 */
export function parseJsonl(text, parseRow, { maxRows = 2_000_000 } = {}) {
  const rows = [];
  let malformed = 0;
  let truncated = false;
  const lines = String(text ?? '').split('\n');
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    if (rows.length >= maxRows) { truncated = true; break; }
    let raw;
    try {
      raw = JSON.parse(s);
    } catch {
      malformed += 1;
      continue;
    }
    const parsed = parseRow(raw);
    if (parsed) rows.push(parsed);
    else malformed += 1;
  }
  return { rows, malformed, truncated };
}

/** Validate the result.json a harness writes. */
export function parseResult(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const marketSummaries = Array.isArray(r.market_summaries) ? r.market_summaries.slice(0, 100_000) : [];
  const crosschecks = Array.isArray(r.crosschecks) ? r.crosschecks.slice(0, 100_000) : [];
  return {
    marketsRun: finite(r.markets_run) ? r.markets_run : 0,
    eventsSeen: finite(r.events_seen) ? r.events_seen : 0,
    feesPaid: finite(r.fees_paid) ? r.fees_paid : 0,
    logTruncated: Boolean(r.log_truncated),
    budget: r.budget && typeof r.budget === 'object' ? r.budget : null,
    marketSummaries: marketSummaries.filter((m) => m && typeof m === 'object').map((m) => ({
      market_id: typeof m.market_id === 'string' ? m.market_id : null,
      asset: typeof m.asset === 'string' ? m.asset : null,
      interval: typeof m.interval === 'string' ? m.interval : null,
      outcome: m.outcome === 'UP' || m.outcome === 'DOWN' ? m.outcome : null,
      up_px: finite(m.up_px) ? m.up_px : null,
      down_px: finite(m.down_px) ? m.down_px : null,
      stream: typeof m.stream === 'string' ? m.stream : null,
    })),
    crosschecks: crosschecks.filter((c) => c && typeof c === 'object').map((c) => ({
      market_id: typeof c.market_id === 'string' ? c.market_id : null,
      claimed: c.claimed ?? null,
      official: c.official ?? null,
      match: Boolean(c.match),
    })),
    rejection: r.rejection && typeof r.rejection === 'object'
      ? { code: String(r.rejection.code ?? 'E_RUNTIME'), detail: String(r.rejection.detail ?? '').slice(0, 4000) }
      : null,
  };
}

/**
 * Authenticate one output line.
 *
 * Truncated to 128 bits: this is a forgery check against a process that cannot
 * read the key, not a long-term signature, and a shorter tag keeps the per-row
 * overhead down across millions of rows.
 */
export function lineMac(key, channel, payload) {
  return createHmac('sha256', key).update(`${channel} ${payload}`).digest('hex').slice(0, 32);
}

/**
 * Split and verify one output line.
 *
 * Returns null for anything that does not authenticate — which is what a
 * strategy writing to /proc/self/fd/3 produces. Constant-time compare because
 * the tag is a secret-derived value and the loop runs per row.
 */
export function parseOutputLine(key, line) {
  const first = line.indexOf(' ');
  if (first !== 32) return null;
  const second = line.indexOf(' ', first + 1);
  if (second !== first + 2) return null;
  const mac = line.slice(0, first);
  const channel = line[first + 1];
  const payload = line.slice(second + 1);

  const want = Buffer.from(lineMac(key, channel, payload), 'utf8');
  const got = Buffer.from(mac, 'utf8');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return { channel, payload };
}
