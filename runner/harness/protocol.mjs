// Worker-to-harness protocol. Output is untrusted because the harness shares
// a process with strategy code. The worker validates shapes, bounds arrays
// and computes reports from trade and fill logs outside the sandbox.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { OUTCOMES } from '../engine/portfolio.mjs';

// One worker-side implementation computes report metrics for both languages.

/**
 * Jobs arrive on stdin, not on a strategy-readable filesystem path.
 * The analyser rejects process (JS) and sys (Python), which expose stdin.
 *
 * The stream is newline-framed:
 *
 *   <job json>
 *   {"market": {...}, "n": <count>}
 *   <event json>            x count
 *   {"market": {...}, "n": <count>}
 *   ...
 *
 * Markets arrive one at a time to bound memory across a run.
 */
export const JOB_FILE = 'job.json';

/**
 * Results return over an authenticated stdout pipe, without an output directory.
 * Sent rows cannot be replaced or deleted. Each line has a MAC using a per-run
 * key read from stdin before strategy import. Direct writes to /proc/self/fd
 * cannot forge valid lines.
 *
 * This does not protect against full code execution that extracts the key
 * from harness state.
 *
 * Line format: <mac> <channel> <payload>
 */
export const CHANNEL = Object.freeze({
  trade: 't',
  fill: 'f',
  log: 'l',
  result: 'r',
  /**
   * Completed-market acknowledgement for display, not an authoritative work count.
   */
  progress: 'p',
  /**
   * Recorder sample or final value: {key, ts, cash, marked, position_value, final}.
   * Used as input to the report's record block.
   */
  record: 'v',
});

/** Fields of a record line, in order. Keep in sync with RECORD_FIELDS in otharness.py. */
export const RECORD_FIELDS = Object.freeze(['key', 'ts', 'cash', 'marked', 'position_value', 'final']);

/**
 * The recorder's budgets for a whole run. Rows: market samples plus the
 * account grid the report builds from them (counted before it is built).
 * Bytes: the encoded record lines, MAC and channel included. Either reached ->
 * recording stops for the run and the report carries no series at all.
 * Keep in sync with otharness.py.
 */
export const MAX_RECORD_ROWS = 1_000_000;
export const MAX_RECORD_BYTES = 256 * 1024 * 1024;

/**
 * One record line, validated: a finite number for every value, a boolean
 * final, a string key. Anything else is not a sample. Keep in sync with parse_record.
 */
export function parseRecord(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.key !== 'string') return null;
  for (const f of ['ts', 'cash', 'marked', 'position_value']) {
    if (typeof raw[f] !== 'number' || !Number.isFinite(raw[f])) return null;
  }
  if (typeof raw.final !== 'boolean') return null;
  return { key: raw.key, ts: raw.ts, cash: raw.cash, marked: raw.marked, position_value: raw.position_value, final: raw.final };
}

/** Bytes one result line takes on the stream: `<mac32> <channel> <payload>\n`. */
export function lineBytes(channel, payload) {
  return 32 + 1 + channel.length + 1 + new TextEncoder().encode(payload).length + 1;
}

/**
 * Authenticated results use container stdout. Docker exposes only stdin, stdout
 * and stderr; an extra Docker-client pipe is not a container fd. Before strategy
 * import, Python duplicates stdout and redirects fd 1 to /dev/null; JS replaces
 * console with an object holding no streams. MACs authenticate lines even when
 * /proc/self/fd is addressable.
 */
export const RESULT_FD = 1;

/** Exit codes a harness may use. Anything else is treated as a crash. */
export const EXIT = Object.freeze({
  ok: 0,
  /**
   * Invalid strategy or manifest.
   */
  rejected: 10,
  /**
   * Strategy exceeded a limit; no report was produced.
   */
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
  'liquidity', 'order_id', 'queue_ahead_at_join', 'queue_ahead_at_fill', 'time_in_queue_ms',
  'markout_1s', 'markout_10s', 'markout_60s', 'markout_settle',
]);

/** The maker block's counters, and nothing else, from a harness result. */
export const MAKER_STAT_KEYS = Object.freeze([
  'submitted', 'rested', 'rested_size', 'taker_on_arrival_size', 'maker_filled_size', 'maker_fills',
  'orders_with_maker_fill', 'fully_filled', 'cancelled', 'cancelled_before_entry',
  'cancelled_no_position', 'expired', 'rejected_invalid', 'rejected_post_only',
  'rejected_self_cross', 'rejected_duplicate_id', 'cancel_noop', 'lag_suppressed_size',
  'crossed_observations',
]);

const finite = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Validate a trade row and project known fields, or return null.
 * Malformed rows are dropped and counted rather than aborting the run.
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
  // undefined marks an invalid supplied price; null represents a missing one.
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
    outcome: OUTCOMES.includes(raw.outcome) ? raw.outcome : undefined,
    ...genericTradeFields(raw),
  };
}

const label = (v) => (typeof v === 'string' ? v.slice(0, 200) : null);
const numOrNull = (v) => (finite(v) ? v : null);

/**
 * Additional generic-market fields, selected only when a row has a label.
 * Keep in sync with the Python report parser.
 */
function genericTradeFields(raw) {
  if (typeof raw.label !== 'string') return {};
  return {
    label: label(raw.label),
    mark_px: raw.mark_px == null ? null : (finite(raw.mark_px) && raw.mark_px >= 0 && raw.mark_px <= 1 ? raw.mark_px : null),
    marked_size: numOrNull(raw.marked_size),
    marked_pnl: numOrNull(raw.marked_pnl),
    mark_source: ['up_mid', 'down_mid', 'last_trade'].includes(raw.mark_source) ? raw.mark_source : null,
    mark_ts_ms: numOrNull(raw.mark_ts_ms),
    mark_age_ms: numOrNull(raw.mark_age_ms),
    mark_missing: ['no_quote', 'stale'].includes(raw.mark_missing) ? raw.mark_missing : null,
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
    // A row from before resting orders existed has no `liquidity`, and every
    // such row was a taker fill.
    liquidity: raw.liquidity === 'maker' ? 'maker' : 'taker',
    order_id: typeof raw.order_id === 'string' ? raw.order_id.slice(0, 16) : null,
    queue_ahead_at_join: px(raw.queue_ahead_at_join),
    queue_ahead_at_fill: px(raw.queue_ahead_at_fill),
    time_in_queue_ms: px(raw.time_in_queue_ms),
    markout_1s: px(raw.markout_1s),
    markout_10s: px(raw.markout_10s),
    markout_60s: px(raw.markout_60s),
    markout_settle: px(raw.markout_settle),
    ...(typeof raw.label === 'string' ? { label: label(raw.label) } : {}),
    // Execution options (phase 2a): present exactly when the run enabled them.
    ...('reject_reason' in raw ? { reject_reason: REJECT_REASONS.includes(raw.reject_reason) ? raw.reject_reason : null } : {}),
    ...('rebate' in raw ? { rebate: finite(raw.rebate) ? raw.rebate : 0 } : {}),
  };
}

/** Why an order did not execute, as the engines write it. Keep in sync with the Python report parser. */
export const REJECT_REASONS = Object.freeze(['fok_unfilled', 'quote_guard', 'below_min_size', 'size_step', 'off_tick']);

/** A harness's run-wide order counters (job.engine), or null. */
function parseOrderStats(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rejected = {};
  for (const k of REJECT_REASONS) {
    const v = raw.rejected?.[k];
    if (finite(v) && v > 0) rejected[k] = v;
  }
  return { rejected, rebates: finite(raw.rebates) ? raw.rebates : 0 };
}

/** A harness's summed maker counters: finite non-negative numbers, or null. */
function parseMakerStats(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const k of MAKER_STAT_KEYS) out[k] = finite(raw[k]) && raw[k] >= 0 ? raw[k] : 0;
  return out;
}

/**
 * Parse a JSONL log with a hard row limit to bound worker memory.
 * Return malformed-row counts and truncation status.
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

/**
 * Validate the harness result payload.
 */
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
    maker: parseMakerStats(r.maker),
    orders: parseOrderStats(r.orders),
    timers: r.timers && typeof r.timers === 'object'
      ? { created: finite(r.timers.created) ? r.timers.created : 0, fired: finite(r.timers.fired) ? r.timers.fired : 0, dropped: finite(r.timers.dropped) ? r.timers.dropped : 0 }
      : null,
    // The spot dataset: markets that got any (null unless declared).
    spot: r.spot && typeof r.spot === 'object'
      ? { markets: finite(r.spot.markets) ? r.spot.markets : 0, markets_without: finite(r.spot.markets_without) ? r.spot.markets_without : 0 }
      : null,
    // The recorder's budgets as the harness spent them (null when off).
    record: r.record && typeof r.record === 'object'
      ? { rows: finite(r.record.rows) ? r.record.rows : 0, bytes: finite(r.record.bytes) ? r.record.bytes : 0, truncated: r.record.truncated === true }
      : null,
    marketSummaries: marketSummaries.filter((m) => m && typeof m === 'object').map((m) => ({
      market_id: typeof m.market_id === 'string' ? m.market_id : null,
      asset: typeof m.asset === 'string' ? m.asset : null,
      interval: typeof m.interval === 'string' ? m.interval : null,
      outcome: OUTCOMES.includes(m.outcome) ? m.outcome : null,
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
 * Authenticate an output line with a 128-bit truncated HMAC.
 * The shorter tag reduces per-row overhead; this is not a long-term signature.
 */
export function lineMac(key, channel, payload) {
  return createHmac('sha256', key).update(`${channel} ${payload}`).digest('hex').slice(0, 32);
}

/**
 * Split and authenticate an output line, or return null.
 * Compare secret-derived tags in constant time.
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
