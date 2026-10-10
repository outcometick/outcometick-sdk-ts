// Types for the data-subscription client, `outcometick/data`.
//
// Hand-written against api/subscription-api.mjs, like the strategy SDK's
// declarations, and guarded the same way — see client/data-types.test.mjs.

/** A filter value: one alternative, or several meaning "any of these". */
export type Filter = string | readonly string[];

/** The sentinel naming files that have no value for a dimension. */
export declare const NO_VALUE: 'none';

export declare const DEFAULT_BASE_URL: string;

/** An error carrying the status and whatever the API said alongside it. */
export declare class OutcometickError extends Error {
  readonly status: number;
  /** The API's `error` string. */
  readonly detail: string;
  /**
   * The parsed response. A 403 on a date outside coverage also carries `floor`
   * and `ceiling` — the difference between "no" and "no, but here is the range
   * you do have".
   */
  readonly body: unknown;
  readonly url: string;
}

/** One archive file, as returned by `files()`. */
export interface FileRow {
  date: string;
  name: string;
  venue: string;
  dataset: string;
  /** null for datasets that are not per-asset. */
  asset: string | null;
  /** null for streams with no period — the settlement feeds. */
  interval: string | null;
  bytes: number;
  sha256: string;
  /** Direct download; needs the key, as a header or `?api_key=`. */
  url: string;
  /** format=parquet only: the row count, and the archive file it was built from. */
  rows?: number;
  source?: string;
}

export interface FilesResult {
  from: string;
  to: string;
  /** Days actually in scope within [from, to], not the span. */
  days: number;
  count: number;
  /** Total size of the matched files. */
  bytes: number;
  files: FileRow[];
  /** format=parquet only. */
  format?: 'parquet';
  /** format=parquet only: matching files whose Parquet copy is not built yet. */
  pending?: number;
}

export interface FilesQuery {
  /** One day. Cannot be combined with from/to. */
  date?: string;
  /** Inclusive start. Defaults to the newest day in scope. */
  from?: string;
  /** Inclusive end. Defaults to `from`. */
  to?: string;
  venue?: Filter;
  dataset?: Filter;
  /**
   * The BASE symbol — `BTC`, `ETH`, `SOL`, … NOT the trading pair. Files are
   * named `BTCUSD-…`, but the dimension is `BTC`; `"BTCUSD"` matches nothing.
   * `meta().assets` lists the real values.
   */
  asset?: Filter;
  /** `"none"` selects the streams that have no period at all. */
  interval?: Filter;
  /** `"parquet"` lists the Parquet copy of each file; omitted means the .gz archive files. */
  format?: 'gz' | 'parquet';
}

export interface MetaResult {
  firstDay?: string;
  lastDay?: string;
  /** Number of days in scope, not a span. */
  days: number;
  venues: string[];
  assets: string[];
  /** Real durations only — the sentinel lives in `filterTokens`. */
  intervals: string[];
  /** dataset name -> human description. */
  datasets: Record<string, string>;
  filterTokens: {
    noValue: 'none';
    /** Which dimensions some file leaves empty. */
    appliesTo: string[];
  };
  scope?: unknown;
  sampledFrom?: string;
}

export interface DaysResult {
  days: string[];
  /** Earliest downloadable day, or null when unbounded. */
  floor: string | null;
  /** Latest downloadable day, or null when unbounded. */
  ceiling: string | null;
  scope?: unknown;
}

export interface SignedUrl {
  url: string;
  name: string;
  bytes: number;
  sha256: string;
  expiresInSec: number;
}

export interface DownloadResult {
  bytes: Uint8Array;
  /** The checksum that was verified, when one was available. */
  sha256: string | null;
  name: string;
  date: string;
}

export interface DownloadOptions {
  /** Verify the sha256. Default true. */
  verify?: boolean;
  /** Also write the bytes to this path. */
  saveTo?: string;
}

/** One list's state on one day, as /v1/smart/days reports it. */
export type SmartListState =
  | { status: 'published'; rows: number; bytes: number; sha256: string }
  | { status: 'stopped'; reason: string | null }
  | { status: 'missing' };

export interface SmartDaysResult {
  /** 'smart100' | 'smart1000' */
  plan: string;
  /** The lists this plan may download. */
  lists: Array<'top100' | 'top1000'>;
  window: { from: string; to: string } | null;
  /** Newest first, every calendar day in the window. */
  days: Array<{ day: string; lists: Partial<Record<'top100' | 'top1000', SmartListState>> }>;
}

export interface SmartDownloadResult {
  bytes: Uint8Array;
  sha256: string | null;
  day: string;
  list: 'top100' | 'top1000';
}

export interface SmartCoverage {
  firstDay: string | null;
  lastDay: string | null;
  days: number;
}

export interface DataClientOptions {
  /** Defaults to process.env.OT_KEY. */
  key?: string | null;
  /** Defaults to https://outcometick.com. */
  baseUrl?: string;
  /** Injectable for tests. */
  fetch?: typeof globalThis.fetch;
}

export declare class DataClient {
  constructor(options?: DataClientOptions);
  readonly key: string | null;
  readonly baseUrl: string;

  /** The date window and every dimension value in it. */
  meta(): Promise<MetaResult>;

  /** The days this key may download, with the window bounds. */
  days(): Promise<DaysResult>;

  /** Search across a date range. Filters accept a string or an array. */
  files(query?: FilesQuery): Promise<FilesResult>;

  /** A presigned URL, without fetching the bytes. Short-lived. */
  signUrl(date: string, name: string, options?: { expiresIn?: number }): Promise<SignedUrl>;

  /** Download one file, verifying its checksum. */
  download(file: FileRow, options?: DownloadOptions): Promise<DownloadResult>;
  download(date: string, name: string, options?: DownloadOptions): Promise<DownloadResult>;

  /** Public — no key required. */
  coverage(): Promise<unknown>;
  plans(): Promise<unknown>;
  health(): Promise<unknown>;

  /** Smart money (its own key): the days this key may download. */
  smartDays(): Promise<SmartDaysResult>;
  /** Smart money: one day's zstd CSV, checksum-verified. */
  smartDownload(day: string, list?: 'top100' | 'top1000', options?: DownloadOptions): Promise<SmartDownloadResult>;
  /** Public: how many smart-money days are published. */
  smartCoverage(): Promise<SmartCoverage>;
  /** Public: smart-money plans (USD) and whether it is on sale. */
  smartPlans(): Promise<{ onSale: boolean; plans: Array<{ planId: string; plan: string; usd: number; passUsd: number | null; interval: string }> }>;
}

/** One price level, spelled as the archive wrote it. */
export interface BookLevel {
  price: string;
  size: string;
}

/** A token's rebuilt ladder, best level first on each side. */
export interface BookLadder {
  bids: BookLevel[];
  asks: BookLevel[];
}

/**
 * Rebuilds a Polymarket order book, per outcome token, from the archive's
 * `book`, `price_change` and `best_bid_ask` rows fed in receipt order
 * (`recv_ms`). A snapshot replaces the token's ladder, a change sets a level to
 * an absolute size (0 removes it), and levels crossed by the newest best bid or
 * ask are dropped. That cannot restore what dropped frames added or resized:
 * until the next snapshot a level, at the top too, can be missing or carry an
 * old size. Other row types are ignored.
 */
export declare class OrderBook {
  constructor();
  /** Apply one archive row: the parsed object, or the JSONL line. */
  apply(row: object | string): this;
  /** Token ids seen so far. */
  assets(): string[];
  ladder(assetId: string): BookLadder;
  /** The best level of the rebuilt ladder — not the market's latest best bid/ask (read best_bid_ask rows for that). */
  best(assetId: string): { bid: BookLevel | null; ask: BookLevel | null };
}

export default DataClient;
