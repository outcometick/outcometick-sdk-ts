// Type declarations for the `outcometick` strategy SDK.
//
// Hand-written against runner/engine/replay.mjs rather than generated, because
// the runtime is plain ESM. The value here is that a strategy which
// type-checks is a strategy the validator will accept: the hook names, the
// hook arities and the shape of `ctx` are all things the queue rejects on, and
// finding out at compile time is free while finding out after queueing is not.
//
// Anything not declared here does not exist at runtime either. `ctx` is frozen
// and the SDK deliberately exposes no way to reach the network, the clock or
// the filesystem — see the docs' "Not supported" list.

export type Side = 'UP' | 'DOWN';

/**
 * How a market settled. `'TIE'` is a 50:50 settlement — Predict.fun resolves
 * an end price equal to the start price this way, and every UP and DOWN
 * contract pays $0.50.
 */
export type Outcome = Side | 'TIE';

export declare const SIDES: readonly ['UP', 'DOWN'];

/** One level of resting depth: [price, size]. */
export type Level = [number, number];

/**
 * The book as of one millisecond, frozen.
 *
 * A read-only facade over the engine's live book — mutating what you get back
 * reaches nothing, and there is no way to see a later state through it.
 */
export interface BookView {
  readonly marketId: string;
  readonly ts: number;
  /** Best ask for `side` — what you pay to open. */
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
}

/** A settlement-stream observation — what on_tick receives. */
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
 * The asks and bids of one outcome token, as the archive sent them. The order is
 * not guaranteed (venues sort differently), so find the best price rather than
 * taking element 0 — `ctx.book()` already does.
 */
export interface Ladders {
  asks: Level[];
  bids: Level[];
}

/**
 * What on_book receives: the book CHANGE that was just applied, not the book.
 *
 * Read the book it produced through `ctx.book()`. The event carries no
 * `market_id` — the hook only fires for the market being replayed. A snapshot
 * replaces the ladders it names (Polymarket sends one side per row, so `levels`
 * may hold only `side`); a delta sets one level, and size 0 removes it.
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
 * A market, as a hook sees it.
 *
 * `outcome` is absent everywhere except `onSettle`. That is not an oversight:
 * before settlement the official label does not exist yet from the strategy's
 * point of view, and handing it over early is look-ahead.
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
 * Everything a strategy can do.
 *
 * Constructed by the runner and frozen. Every accessor is clamped to the
 * current event time, so none of it can see the future by construction rather
 * than by convention.
 */
export interface Ctx<P = Record<string, unknown>> {
  /** Params from the manifest, injected before the first hook. */
  readonly p: P;
  /** Current event time in epoch ms. Not the wall clock — there isn't one. */
  readonly now: number;

  /**
   * The book as of this millisecond.
   *
   * Passing another market's id throws unless the manifest declared session
   * mode; cross-market reads are what that mode is for.
   */
  book(id?: string | null): BookView;

  /** The last `n` ticks already seen, oldest first. Always a copy. */
  history(n?: number): Tick[];

  position(): Position;

  /** Appended to logs.txt in the archive. Truncated past the log limit. */
  log(msg: unknown): void;

  /** The only randomness available, seeded and recorded in the report. */
  random(seed?: number | null): number;

  /** A reference feed declared in the manifest. Throws if undeclared. */
  ref(name: string): FeedView;

  /** An external series declared in the manifest. Throws if undeclared. */
  ext(name: string): FeedView;

  /** Rolling helpers over the tick history. Identical across languages. */
  zscore(value: number, opts?: { window?: number }): number;
  sma(window?: number): number | null;
  stdev(window?: number): number;
  ema(window?: number): number | null;

  /**
   * Record the strategy's own recompute of the outcome against the official
   * one. Recorded for the cross-check panel, never enforced — a mismatch is
   * information, not a failed run.
   */
  assert_outcome(market: unknown, outcome: Outcome): void;
}

/**
 * Size an order in contracts, or in money.
 *
 * A union rather than two optional fields, so `{ size, notional }` together is
 * a compile error rather than a run-time rejection: they answer the same
 * question two ways and there is no sensible reading of both.
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
     * Spend at most this much, converted to contracts as
     * `floor(notional / limit)`.
     *
     * REQUIRES `limit`, which is why this arm makes it non-optional: a
     * contract costs whatever it fills at and a marketable order walks the
     * book, so dividing by the current best price overspends the moment there
     * is any slippage. The limit is the price you have already said you will
     * not exceed, which is what makes "at most" true.
     */
    notional: number;
    limit: number;
  };

export type OrderInit = OrderSizing & {
  side: Side;
  /**
   * A bound in whichever direction protects you: a ceiling when opening, a
   * floor when reducing. Must be within [0, 1] — a binary outcome token
   * trades nowhere else.
   */
  limit?: number | null;
  holdS?: number | null;
  hold_s?: number | null;
  reduceOnly?: boolean;
  reduce_only?: boolean;
  /** Only 'ioc' is modelled; anything else is rejected at construction. */
  tif?: 'ioc';
  tag?: string | null;
};

/**
 * An order a hook returns.
 *
 * Never sent — returned, and matched by the runner against the depth that was
 * actually resting at that millisecond.
 */
export declare class Order {
  constructor(init: OrderInit);
  readonly side: Side;
  readonly size: number;
  readonly limit: number | null;
  readonly hold_s: number | null;
  readonly reduce_only: boolean;
  readonly tif: 'ioc';
  readonly tag: string | null;
}

/**
 * Base class for a submitted strategy.
 *
 * The hooks are intentionally not declared as members: implementing one you
 * did not list in the manifest does nothing, and listing one you did not
 * implement is a rejection. Declare them in `outcometick.json` and write them
 * with these signatures.
 *
 *     onMarketOpen(ctx: Ctx, market: Market): void
 *     onTick(ctx: Ctx, tick: Tick): Order | null
 *     onBook(ctx: Ctx, event: BookEvent): Order | null   // the book itself: ctx.book()
 *     onTrade(ctx: Ctx, trade: TradeEvent): Order | null
 *     onSettle(ctx: Ctx, market: Market, outcome: Outcome): void
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
