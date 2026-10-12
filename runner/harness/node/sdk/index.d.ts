// Type declarations for the outcometick strategy SDK.
// Maintained by hand for the plain ESM runtime; keep hook signatures and ctx
// in sync with runner/engine/replay.mjs. Strategies use event time and cannot
// access network, wall-clock or filesystem APIs through the SDK.

export type Side = 'UP' | 'DOWN';

/**
 * Settlement result. TIE pays $0.50 per UP and DOWN contract; Predict.fun
 * uses it when the end price equals the start price.
 */
export type Outcome = Side | 'TIE';

export declare const SIDES: readonly ['UP', 'DOWN'];

/** One level of resting depth: [price, size]. */
export type Level = [number, number];

/**
 * Frozen book view at one millisecond.
 * Returned data cannot mutate the live book or reveal later states.
 */
export interface BookView {
  readonly marketId: string;
  readonly ts: number;
  /** Best ask for `side`, what you pay to open. */
  best(side: Side): number | null;
  bestBid(side: Side): number | null;
  best_bid(side: Side): number | null;
  /** Size available at or better than `bound` (all of it when omitted). */
  depth(side: Side, bound?: number | null): number;
  bidDepth(side: Side, bound?: number | null): number;
  bid_depth(side: Side, bound?: number | null): number;
  levels(side: Side, n?: number): Level[];
  bidLevels(side: Side, n?: number): Level[];
  bid_levels(side: Side, n?: number): Level[];
  mid(side: Side): number | null;
  /** When each best level of `side` was last set (exchange ms); null for an empty ladder. */
  quoteTs(side: Side): { bid: number | null; ask: number | null };
  quote_ts(side: Side): { bid: number | null; ask: number | null };
}

/** A settlement-stream observation, what on_tick receives. */
export interface Tick {
  kind: 'tick';
  ts_ms: number;
  market_id: string;
  value: number;
  /** The settlement stream this row came from, e.g. `twap60s`. */
  source?: string;
  server_ts_ms?: number | null;
  recv_ts_ms?: number | null;
}

/**
 * Archived asks and bids for an outcome token. Venues use different sort
 * orders, so find the best price rather than using element 0, or use ctx.book().
 */
export interface Ladders {
  asks: Level[];
  bids: Level[];
}

/**
 * The book change passed to onBook. Read the resulting book through ctx.book().
 *
 * No market_id is included: the hook belongs to the current market. Snapshots
 * replace the named ladders; Polymarket rows may contain only one side. Deltas
 * set absolute level sizes, with size 0 removing a level.
 */
export type BookEvent =
  | {
    kind: 'book';
    ts_ms: number;
    snapshot: true;
    side?: Side;
    levels: Partial<Record<Side, Ladders>>;
  }
  | {
    kind: 'book';
    ts_ms: number;
    snapshot: false;
    side: Side;
    ladder: 'asks' | 'bids';
    px: number;
    size: number;
  };

/** What on_trade receives: one trade print in the archive. */
export interface TradeEvent {
  kind: 'trade';
  ts_ms: number;
  market_id: string;
  px: number;
  size: number;
  /** Which outcome token traded. */
  side: Side;
  /** The taker's direction, separate from which outcome traded. */
  taker: 'BUY' | 'SELL';
}

/**
 * Strategy-visible market data.
 * The official outcome is provided only at onSettle to prevent look-ahead.
 */
export interface Market {
  market_id: string;
  asset: string;
  interval: string;
  strike: number | null;
  open_ts_ms: number;
  close_ts_ms: number | null;
}

/** The current position in this market, marked against the real book. */
export interface Position {
  side: Side | null;
  size: number;
  avg_price: number | null;
  unrealized: number | null;
}

/** A declared reference feed or external series, clamped to `ctx.now`. */
export interface FeedView<T = Record<string, number>> {
  /** The most recent row stamped at or before ctx.now, or null. */
  readonly last: T | null;
  /** The last `n` rows at or before ctx.now, oldest first. */
  window(n: number): T[];
  /** The row in effect at `ts`, which may not be later than ctx.now. */
  at(ts: number): T | null;
}

/**
 * Runner-provided, frozen strategy context.
 * Accessors expose data at or before the current event time.
 */
export interface Ctx<P = Record<string, unknown>> {
  /** Params from the manifest, injected before the first hook. */
  readonly p: P;
  /** Current event time in epoch ms. Not the wall clock, there isn't one. */
  readonly now: number;

  /**
   * Frozen book view at one millisecond.
   * Returned data cannot mutate the live book or reveal later states.
   */
  book(id?: string | null): BookView;

  /** The last `n` ticks already seen, oldest first. Always a copy. */
  history(n?: number): Tick[];

  position(): Position;

  /** Appended to logs.txt in the archive. Truncated past the log limit. */
  log(msg: unknown): void;

  /** The only randomness available, seeded and recorded in the report. */
  random(seed?: number | null): number;

  /**
   * Copies of this market's non-final GTC orders.
   * Queue position is omitted because it is not observable at the venue.
   */
  orders(): RestingOrder[];

  /**
   * Cancel a resting order by engine id (`"o3"`, from `orders()`) or by the
   * `clientId` you gave it. Takes effect after the run's cancel latency, and
   * the order stays exposed to fills for the print-lag window after that.
   * False when there is no such order.
   */
  cancel(id: string): boolean;

  /**
   * Wake `onTimer` at `atMs` (a whole millisecond after `now`, not past the
   * market's declared close). Needs `on_timer` in the manifest's hooks.
   * Returns the timer's id. At most 64 pending, 10,000 set, 100,000 fired per
   * market.
   */
  schedule(atMs: number, tag?: string | null): string;

  /** Cancel a pending timer by its id. False when there is none. */
  unschedule(id: string): boolean;

  /** A reference feed declared in the manifest. Throws if undeclared. */
  ref(name: string): FeedView;

  /** An external series declared in the manifest. Throws if undeclared. */
  ext(name: string): FeedView;

  /**
   * The latest value of the market's asset on Chainlink's 1 Hz stream that has
   * reached the strategy, or null. Needs the `spot` dataset (throws otherwise).
   * Like ref(), it only sees values stamped at or before this ctx's now.
   */
  spot(): SpotValue | null;

  /**
   * The elapsed part of the settlement TWAP window [close - lookback, close),
   * from the spot values seen in it, an approximation of Chainlink's average
   * (it uses finer observations than this per-second stream). null when the
   * market does not settle on a TWAP, the window has not started, or no spot
   * value in it has arrived. Needs the `spot` dataset (throws otherwise).
   */
  twap_locked(): TwapLocked | null;
  /** Same as twap_locked(). */
  twapLocked(): TwapLocked | null;

  /** Rolling helpers over the tick history. Identical across languages. */
  zscore(value: number, opts?: { window?: number }): number;
  sma(window?: number): number | null;
  stdev(window?: number): number;
  ema(window?: number): number | null;

  /**
   * Record the strategy's recomputed outcome for comparison with the official
   * result. A mismatch is informational and does not fail the run.
   */
  assert_outcome(market: unknown, outcome: Outcome): void;
}

/**
 * Size an order in contracts or money.
 * The union rejects providing size and notional together at compile time.
 */
export type OrderSizing =
  | {
    /** Contracts. Must be positive. */
    size: number;
    notional?: never;
  }
  | {
    size?: never;
    /**
     * Opening-spend budget, converted to contracts as floor(notional / limit).
     * Requires limit to bound fill prices when the order walks the book.
     */
    notional: number;
    limit: number;
  };

export type OrderInit = OrderSizing & {
  side: Side;
  /**
   * Price ceiling when opening or floor when reducing, within [0, 1].
   */
  limit?: number | null;
  holdS?: number | null;
  hold_s?: number | null;
  reduceOnly?: boolean;
  reduce_only?: boolean;
  tag?: string | null;
} & (
  | {
    /**
     * `ioc` (the default): take what is resting now; anything unfilled is
     * dropped. `fok`: all of it within the limit, or none of it, the
     * manifest must declare `"fok": true`.
     */
    tif?: 'ioc' | 'fok';
    postOnly?: never;
    post_only?: never;
    clientId?: never;
    client_id?: never;
  }
  | {
    /**
     * Rest at `limit` until filled, cancelled or the market closes, behind
     * the queue already at that price (Polymarket only; the manifest must
     * declare the "book" and "trades" datasets). The part that is marketable
     * on arrival takes liquidity first.
     */
    tif: 'gtc';
    /** The price the order rests at, on the 0.001 grid. Required. */
    limit: number;
    /** Refuse the order rather than take liquidity if it is marketable on arrival. */
    postOnly?: boolean;
    post_only?: boolean;
    /** Your handle for ctx.cancel(): 1-64 of A-Z a-z 0-9 _ . : -, not o<digits>. */
    clientId?: string | null;
    client_id?: string | null;
    holdS?: never;
    hold_s?: never;
  }
);

/** A resting order as ctx.orders() reports it. */
export interface RestingOrder {
  /** Engine id, `o1`, `o2`, … per market. */
  readonly id: string;
  readonly client_id: string | null;
  readonly side: Side;
  readonly action: 'open' | 'reduce';
  readonly limit: number | null;
  /** Null until the order reaches the venue (state `pending`). */
  readonly size: number | null;
  readonly remaining: number | null;
  /** `cancel_pending`: cancelled, but still exposed for the print-lag window. */
  readonly state: 'pending' | 'live' | 'cancel_pending';
  readonly placed_ms: number;
}

/**
 * An order returned by a hook for simulated execution by the runner.
 */
export declare class Order {
  constructor(init: OrderInit);
  readonly side: Side;
  readonly size: number;
  readonly limit: number | null;
  readonly hold_s: number | null;
  readonly reduce_only: boolean;
  readonly tif: 'ioc' | 'gtc' | 'fok';
  readonly tag: string | null;
  /** Present on gtc orders only. */
  readonly post_only?: boolean;
  readonly client_id?: string | null;
}

/** ctx.spot(): a value on the asset's 1 Hz Chainlink stream and its feed time. */
export interface SpotValue {
  value: number;
  ts_ms: number;
}

/** ctx.twap_locked(): what the elapsed part of the settlement window holds so far. */
export interface TwapLocked {
  /** Mean of the window's spot samples seen so far. */
  value: number;
  /** How many: one per feed timestamp, no interpolation over gaps. */
  samples: number;
  /** Time since the window opened, capped at the lookback. */
  elapsed_ms: number;
  /** elapsed_ms / lookback: time elapsed, not certainty. */
  elapsed_fraction: number;
  /** samples / elapsed whole seconds, capped at 1. */
  coverage: number;
  /** Feed time of the latest spot value seen. */
  last_ts_ms: number;
  /**
   * elapsed_fraction * value + (1 - elapsed_fraction) * latest spot: the final
   * average if the price stayed where it is. null when coverage < 0.8 or the
   * latest spot is more than 5 s old. Not a forecast.
   */
  projected: number | null;
}

/** A timer set with ctx.schedule(), as onTimer receives it. */
export interface TimerEvent {
  readonly id: string;
  readonly at_ms: number;
  readonly tag: string | null;
}

/**
 * Base class for submitted strategies.
 *
 * Hooks run only when declared in outcometick.json; a declared hook without
 * an implementation is rejected. Use these signatures:
 *
 *     onMarketOpen(ctx: Ctx, market: Market): void
 *     onTick(ctx: Ctx, tick: Tick): Order | null
 *     onBook(ctx: Ctx, event: BookEvent): Order | null   // read depth with ctx.book()
 *     onTrade(ctx: Ctx, trade: TradeEvent): Order | null
 *     onSettle(ctx: Ctx, market: Market, outcome: Outcome): void
 *     onTimer(ctx: Ctx, timer: TimerEvent): Order | null   // ctx.schedule(atMs, tag)
 */
export declare class Strategy<P = Record<string, unknown>> {
  /** Params from the manifest, injected by the runner before the first hook. */
  p: P;
}

declare const _default: {
  Strategy: typeof Strategy;
  Order: typeof Order;
  SIDES: typeof SIDES;
};
export default _default;
