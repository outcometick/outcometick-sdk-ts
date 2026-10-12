// Pre-registration digest of strategy files, defaults, parameters, execution
// options, data scope and seed. Compute before inspecting results. Shared by
// hosted and local runs; keep in sync with client/backtest/fingerprint.py.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { enginePolicyFor, normalizeIntervals } from './backtest-datasets.mjs';
import { SANDBOX_IMAGE_TAG, DECODE_SEMANTICS } from './backtest-contract.mjs';

export const FINGERPRINT_VERSION = 1;
const MANIFEST = 'outcometick.json';
// Hash every submitted file, including config and series. Preserve raw
// manifest bytes because JSON parsing rounds integers above 2^53.

/** JSON with object keys sorted at every level; a non-finite number is null. */
export function canonicalJson(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null';
  if (typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** sha256 over every submitted file, name\0content\0 in name order. */
export function codeDigest(files) {
  const code = [...(files ?? [])]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (!code.length) return null;
  const h = createHash('sha256');
  for (const f of code) h.update(f.name).update('\u0000').update(f.content ?? '').update('\u0000');
  return h.digest('hex');
}

const sortedUnique = (xs) => [...new Set((xs ?? []).map(String))].sort();

/**
 * Digest sorted, unique "path:sha256(bytes)" input lines, or null for no inputs.
 * Report separately from pre-registration because files are known after decoding.
 * Hosted and local inputs use the same relative paths and checksums.
 * Keep in sync with inputs_digest in client/backtest/fingerprint.py.
 */
export function inputsDigest(lines) {
  const list = [...new Set(lines ?? [])].sort();
  return list.length ? sha256(list.join('\n')) : null;
}

/** "path:sha256" lines for local archive files (paths relative to `root`). */
export async function localInputs(root, paths) {
  const out = [];
  for (const p of new Set(paths ?? [])) {
    out.push(`${p}:${createHash('sha256').update(await readFile(path.join(root, p))).digest('hex')}`);
  }
  return out;
}

/** Every UTC day from..to inclusive (YYYY-MM-DD), the hosted queue's range as a list. */
export function expandDays(from, to) {
  const out = [];
  if (!from || !to) return out;
  for (let t = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
    if (out.length > 4000) break;
  }
  return out;
}

/**
 * Generic-data digest: markets file first, then sorted frame files from
 * runner/generic-data.mjs datasetFiles, each encoded as name\0sha256(bytes)\0.
 * Keep in sync with dataset_digest in fingerprint.py.
 */
export async function datasetDigest(root, { marketsFile, files }) {
  const h = createHash('sha256');
  const names = [...(marketsFile ? [marketsFile] : []), ...[...files].sort()];
  for (const name of names) {
    const bytes = await readFile(path.join(root, name));
    h.update(name).update('\u0000').update(createHash('sha256').update(bytes).digest('hex')).update('\u0000');
  }
  return h.digest('hex');
}

/**
 * Canonical input from manifest and scope. params overrides manifest defaults
 * for a sweep cell; code is codeDigest or null for an in-process Python class.
 */
export function fingerprintInput({
  manifest, code = null, scope = {}, seed = 1, data = 'archive', params = undefined, seriesSha = {},
  dataSha256 = null, replay = {}, feeBpsOverride = null,
}) {
  const m = manifest ?? {};
  const entry = typeof m.entry === 'string' ? m.entry
    : (m.entry && typeof m.entry === 'object' ? `${m.entry.file}:${m.entry.className}` : null);
  return {
    v: FINGERPRINT_VERSION,
    code,
    // The manifest as parsed, unknown fields included; its exact bytes are in
    // `code`. The fields below spell out the defaults it implies.
    manifest_doc: m,
    language: m.language ?? null,
    entry,
    hooks: sortedUnique(m.hooks),
    datasets: sortedUnique(m.datasets),
    intervals: data === 'generic' ? null : sortedUnique(normalizeIntervals(m.intervals)),
    mode: m.mode ?? 'market',
    latency: m.latency ?? 0,
    cancel_latency: m.cancel_latency ?? null,
    fee_bps: m.fee_bps ?? null,
    // The fee policy actually applied: an operator or `--fee-bps` override wins
    // over the manifest, as feePolicyFor decides at run time.
    fee: feeBpsOverride != null ? { mode: 'bps', bps: feeBpsOverride }
      : (m.fee_bps != null ? { mode: 'bps', bps: m.fee_bps } : { mode: 'venue' }),
    // What executes it: the engine image (engine + harness) and the decoder.
    implementation: { image: SANDBOX_IMAGE_TAG, decode: DECODE_SEMANTICS },
    params: params !== undefined ? params : (m.params ?? {}),
    reference: sortedUnique(m.reference),
    // Include series checksums so changing data changes the fingerprint.
    series: [...(m.series ?? [])].map((s) => ({
      name: s?.name ?? null, file: s?.file ?? null, lag_ms: s?.lag_ms ?? 0, sha256: seriesSha[s?.file] ?? null,
    }))
      .sort((a, b) => (String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0)),
    engine: enginePolicyFor({ manifest: m, venue: scope.venue ?? 'polymarket', data }),
    // Archive: the slice is named by the scope below. Your own data: its bytes.
    data: { kind: data, sha256: data === 'generic' ? dataSha256 : null },
    // Local replay settings that change what is replayed (defaults spelled out).
    replay: {
      book_throttle: replay.bookThrottle === false ? 'off' : 'on',
      mark_max_age_ms: replay.markMaxAgeMs ?? null,
    },
    scope: {
      venue: scope.venue ?? null,
      assets: sortedUnique((scope.assets ?? []).map((a) => String(a).toUpperCase())),
      // Actual replay days in order, including gaps.
      days: [...(scope.days ?? [])].map(String),
    },
    seed: seed ?? 1,
  };
}

/**
 * Run fingerprint: version, sha256, code_sha256 and data_sha256.
 */
export function runFingerprint(args) {
  const input = fingerprintInput(args);
  return {
    version: FINGERPRINT_VERSION, sha256: sha256(canonicalJson(input)), code_sha256: input.code,
    data_sha256: input.data.sha256,
  };
}

/** From a submission's files (readSubmission / the stored source): manifest + code. */
export function fingerprintOfFiles(files, {
  scope, seed = 1, data = 'archive', params = undefined, feeBpsOverride = null, dataSha256 = null, replay = {},
  inputs = null,
} = {}) {

  const doc = (files ?? []).find((f) => f.name === MANIFEST);
  let manifest = null;
  try { manifest = doc ? JSON.parse(doc.content) : null; } catch { manifest = null; }
  if (!manifest || typeof manifest !== 'object') return null;
  // Hash declared series files regardless of extension.
  const byName = new Map((files ?? []).map((f) => [f.name, f]));
  const seriesSha = {};
  for (const s of Array.isArray(manifest.series) ? manifest.series : []) {
    const f = typeof s?.file === 'string' ? byName.get(s.file) : null;
    if (f) seriesSha[s.file] = sha256(f.content ?? '');
  }
  const fp = runFingerprint({ manifest, code: codeDigest(files), scope, seed, data, params, seriesSha, dataSha256, replay, feeBpsOverride });
  return { ...fp, inputs_sha256: inputs ? inputsDigest(inputs) : null };
}
