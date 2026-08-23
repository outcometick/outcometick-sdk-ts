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
  asset?: Filter;
  /** `"none"` selects the streams that have no period at all. */
  interval?: Filter;
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
}

export default DataClient;
