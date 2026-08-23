// Validating `outcometick.json` and the files that come with it.
//
// This is the validator the docs promise `ot check` runs: "if it passes locally
// it will not be rejected on submit". That promise only survives if there is
// exactly ONE implementation — so the CLI, the API and the runner all call
// this, and none of them re-derive a rule of their own.
//
// Everything here is free and happens before a credit is held. A rejection
// costs the submitter nothing, so the checks lean strict: a manifest that is
// ambiguous is rejected rather than interpreted.

import {
  LANGUAGES, KNOWN_LANGUAGES, HOOKS, KNOWN_HOOKS, HOOK_NAMES, LIMITS, MODES,
  KNOWN_MODES, SCHEMA_VERSION, BacktestRejection, parseReferenceFeed,
} from './backtest-contract.mjs';
import { normalizeDatasets, assertCoverage } from './backtest-datasets.mjs';

/** The one file name that is not the submitter's to choose. */
export const MANIFEST_NAME = 'outcometick.json';

/**
 * File names must be plain, relative and flat-ish. A submission is not unpacked
 * — the files arrive as text with names attached — but the runner does write
 * them to a scratch directory, and a name is the one field that reaches a
 * filesystem call. `..`, absolute paths, backslashes and control characters are
 * all rejected rather than sanitised: a name we had to repair is a name the
 * submitter did not mean.
 */
const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

function assertSafeName(name, what = 'file') {
  const n = String(name ?? '');
  if (!n) throw new BacktestRejection('E_MANIFEST', `${what} name is empty`);
  if (n.length > LIMITS.maxFileNameLength) {
    throw new BacktestRejection('E_MANIFEST', `${what} name longer than ${LIMITS.maxFileNameLength} characters: ${n.slice(0, 32)}…`);
  }
  if (!SAFE_NAME.test(n) || n.includes('..') || n.includes('//')) {
    throw new BacktestRejection('E_MANIFEST', `${what} name is not a plain relative path: ${JSON.stringify(n)}`);
  }
  return n;
}

/**
 * Parse the manifest text.
 *
 * A manifest that is not JSON, or is JSON but not an object, is E_MANIFEST and
 * not E_ENTRY — the distinction matters because the codes drive what the CLI
 * tells someone to go and look at.
 */
export function parseManifest(text) {
  let doc;
  try {
    doc = JSON.parse(String(text));
  } catch (err) {
    throw new BacktestRejection('E_MANIFEST', `${MANIFEST_NAME} is not valid JSON: ${err.message}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new BacktestRejection('E_MANIFEST', `${MANIFEST_NAME} must be a JSON object`);
  }
  return doc;
}

/**
 * Validate the manifest on its own, without the files.
 *
 * Returns a normalised manifest: every optional field present with its default,
 * every list de-duplicated and in a stable order. Downstream code reads the
 * normalised form only, so no consumer has to repeat "or the default".
 */
export function validateManifest(doc) {
  if (doc.schema !== SCHEMA_VERSION) {
    throw new BacktestRejection('E_MANIFEST',
      `unsupported schema ${JSON.stringify(doc.schema)}; this runner speaks schema ${SCHEMA_VERSION}`);
  }

  const language = String(doc.language ?? '');
  if (!KNOWN_LANGUAGES.includes(language)) {
    throw new BacktestRejection('E_MANIFEST',
      `unsupported language ${JSON.stringify(doc.language)}; supported: ${KNOWN_LANGUAGES.join(', ')}`);
  }
  const lang = LANGUAGES[language];

  // entry is "file:ClassName" — resolved by exact name, no discovery.
  const entryRaw = String(doc.entry ?? '');
  const sep = entryRaw.lastIndexOf(':');
  if (sep <= 0 || sep === entryRaw.length - 1) {
    throw new BacktestRejection('E_ENTRY',
      `entry must be "file:ClassName", got ${JSON.stringify(doc.entry)}`);
  }
  const entryFile = assertSafeName(entryRaw.slice(0, sep), 'entry file');
  const entryClass = entryRaw.slice(sep + 1);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entryClass)) {
    throw new BacktestRejection('E_ENTRY', `entry class name is not an identifier: ${JSON.stringify(entryClass)}`);
  }

  // hooks
  if (!Array.isArray(doc.hooks) || doc.hooks.length === 0) {
    throw new BacktestRejection('E_MANIFEST', 'hooks must be a non-empty array');
  }
  const hooks = [];
  for (const raw of doc.hooks) {
    const h = String(raw ?? '');
    if (!KNOWN_HOOKS.includes(h)) {
      throw new BacktestRejection('E_MANIFEST',
        `unknown hook ${JSON.stringify(h)}; known: ${KNOWN_HOOKS.join(', ')}`);
    }
    if (!hooks.includes(h)) hooks.push(h);
  }
  // At least one hook must be able to return an Order, or the run cannot
  // produce a trade and the report would be an empty equity curve the
  // submitter paid for.
  if (!hooks.some((h) => HOOKS[h].emitsOrders)) {
    throw new BacktestRejection('E_MANIFEST',
      `no hook that can return an Order was declared; one of ${KNOWN_HOOKS.filter((h) => HOOKS[h].emitsOrders).join(', ')} is required`);
  }

  const datasets = normalizeDatasets(doc.datasets);

  // A hook that needs a dataset it was not given would simply never fire, and
  // a strategy that silently never trades looks like a bad strategy rather
  // than a bad manifest. Say so instead.
  for (const h of hooks) {
    const need = HOOKS[h].requiresDataset;
    if (!need) continue;
    const satisfied = need === 'settlement'
      ? datasets.some((d) => d === 'settlement' || d === 'prices' || d.startsWith('twap'))
      : datasets.includes(need);
    if (!satisfied) {
      throw new BacktestRejection('E_MANIFEST',
        `hook ${h} needs the ${need} dataset, which is not declared`);
    }
  }

  // mode
  const mode = doc.mode == null ? 'market' : String(doc.mode);
  if (!KNOWN_MODES.includes(mode)) {
    throw new BacktestRejection('E_MANIFEST',
      `unknown mode ${JSON.stringify(doc.mode)}; known: ${KNOWN_MODES.join(', ')}`);
  }

  // deps — names only, from the per-language allowlist. Versions are ours.
  const deps = [];
  if (doc.deps != null) {
    if (!Array.isArray(doc.deps)) throw new BacktestRejection('E_MANIFEST', 'deps must be an array');
    for (const raw of doc.deps) {
      const d = String(raw ?? '').trim();
      if (/[@=<>~^ ]/.test(d)) {
        throw new BacktestRejection('E_MANIFEST',
          `deps take names only, not versions: ${JSON.stringify(d)}. The runner pins them.`);
      }
      if (!lang.deps.includes(d)) {
        throw new BacktestRejection('E_IMPORT',
          `${d} is not on the ${lang.label} allowlist; available: ${lang.deps.join(', ')}`);
      }
      if (!deps.includes(d)) deps.push(d);
    }
  }

  // reference feeds
  const reference = [];
  if (doc.reference != null) {
    if (!Array.isArray(doc.reference)) throw new BacktestRejection('E_MANIFEST', 'reference must be an array');
    for (const raw of doc.reference) {
      const feed = parseReferenceFeed(raw);
      if (!feed) {
        throw new BacktestRejection('E_MANIFEST',
          `unknown reference feed ${JSON.stringify(raw)}. Ask us and we will add it — adding a feed is cheap.`);
      }
      if (!reference.includes(feed.canonical)) reference.push(feed.canonical);
    }
  }

  // series — the submitter's own CSV/Parquet, aligned to event time
  const series = [];
  if (doc.series != null) {
    if (!Array.isArray(doc.series)) throw new BacktestRejection('E_MANIFEST', 'series must be an array');
    if (doc.series.length > LIMITS.maxSeriesCount) {
      throw new BacktestRejection('E_LIMIT',
        `at most ${LIMITS.maxSeriesCount} series, got ${doc.series.length}`);
    }
    for (const raw of doc.series) {
      if (!raw || typeof raw !== 'object') throw new BacktestRejection('E_MANIFEST', 'each series must be an object');
      const name = String(raw.name ?? '');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new BacktestRejection('E_MANIFEST', `series name is not an identifier: ${JSON.stringify(raw.name)}`);
      }
      if (series.some((s) => s.name === name)) {
        throw new BacktestRejection('E_MANIFEST', `duplicate series name ${JSON.stringify(name)}`);
      }
      const file = assertSafeName(raw.file, 'series file');
      let lagMs = 0;
      if (raw.lag_ms != null) {
        lagMs = Number(raw.lag_ms);
        if (!Number.isInteger(lagMs) || lagMs < 0) {
          throw new BacktestRejection('E_MANIFEST', `series ${name}: lag_ms must be a non-negative integer`);
        }
      }
      series.push({ name, file, lag_ms: lagMs });
    }
  }

  // params — defaults only, reachable as ctx.p
  const params = {};
  if (doc.params != null) {
    if (typeof doc.params !== 'object' || Array.isArray(doc.params)) {
      throw new BacktestRejection('E_MANIFEST', 'params must be an object');
    }
    const keys = Object.keys(doc.params);
    if (keys.length > LIMITS.maxParams) {
      throw new BacktestRejection('E_LIMIT', `at most ${LIMITS.maxParams} params, got ${keys.length}`);
    }
    for (const k of keys) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
        throw new BacktestRejection('E_MANIFEST', `param name is not an identifier: ${JSON.stringify(k)}`);
      }
      const v = doc.params[k];
      const ok = typeof v === 'number' ? Number.isFinite(v)
        : (typeof v === 'string' || typeof v === 'boolean');
      if (!ok) {
        throw new BacktestRejection('E_MANIFEST',
          `param ${k} must be a finite number, string or boolean — a sweep has to be able to vary it`);
      }
      params[k] = v;
    }
  }

  return {
    schema: SCHEMA_VERSION,
    language,
    languageId: lang.id,
    entry: { file: entryFile, className: entryClass },
    hooks,
    datasets,
    mode,
    deps,
    reference,
    series,
    params,
  };
}

/**
 * Validate the submitted files against the manifest and the hard limits.
 *
 * `files` is [{name, content}] as submitted — text only. The manifest itself
 * counts toward both the file count and the size budget, because it is one of
 * the things the submitter has to fit in.
 */
export function validateFiles(files, manifest) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new BacktestRejection('E_MANIFEST', 'no files submitted');
  }
  if (files.length > LIMITS.maxFiles) {
    throw new BacktestRejection('E_LIMIT',
      `at most ${LIMITS.maxFiles} files, got ${files.length}. Archives and repository URLs are not accepted.`);
  }

  const seen = new Map();
  let total = 0;
  for (const f of files) {
    const name = assertSafeName(f?.name);
    if (seen.has(name)) throw new BacktestRejection('E_MANIFEST', `duplicate file ${name}`);
    const content = f?.content;
    if (typeof content !== 'string') {
      throw new BacktestRejection('E_MANIFEST', `file ${name} must be submitted as text`);
    }
    // A NUL byte means this is not the text file it claims to be. We never
    // unpack anything, so this is the whole of the "no archives" enforcement:
    // a zip cannot survive the trip as a JSON string without one.
    if (content.includes('\0')) {
      throw new BacktestRejection('E_MANIFEST',
        `file ${name} contains a NUL byte — submissions are text only, no archives`);
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    total += bytes;
    seen.set(name, { name, bytes, content });
  }

  if (total > LIMITS.maxTotalSourceBytes) {
    throw new BacktestRejection('E_LIMIT',
      `total source is ${total} bytes, over the ${LIMITS.maxTotalSourceBytes} byte limit`);
  }
  if (!seen.has(MANIFEST_NAME)) {
    throw new BacktestRejection('E_MANIFEST', `${MANIFEST_NAME} is required`);
  }
  if (!seen.has(manifest.entry.file)) {
    throw new BacktestRejection('E_ENTRY',
      `entry names ${manifest.entry.file}, which was not submitted`);
  }
  for (const s of manifest.series) {
    if (!seen.has(s.file)) {
      throw new BacktestRejection('E_MANIFEST',
        `series ${s.name} names ${s.file}, which was not submitted`);
    }
  }

  const lang = LANGUAGES[manifest.language];
  for (const { name } of seen.values()) {
    if (name === MANIFEST_NAME) continue;
    if (manifest.series.some((s) => s.file === name)) continue; // data files, any extension
    const ext = name.slice(name.lastIndexOf('.'));
    if (!lang.sourceExtensions.includes(ext)) {
      throw new BacktestRejection('E_MANIFEST',
        `${name} is not a ${lang.label} source file; expected one of ${lang.sourceExtensions.join(', ')}`);
    }
  }

  return { files: [...seen.values()], totalBytes: total };
}

/**
 * The full pre-billing check: manifest, files, and the scope it will run over.
 *
 * Scope is checked here rather than at submission time because coverage is a
 * property of the manifest's declared datasets crossed with the requested
 * range, and both come from the submitter. Getting E_COVERAGE from `ot check`
 * is the difference between fixing a manifest and buying a useless run.
 *
 * @param {{manifestText?:string, manifest?:object, files:Array, scope:object}} input
 */
export function checkSubmission({ manifestText, manifest: manifestDoc, files, scope }) {
  const doc = manifestDoc ?? parseManifest(
    manifestText ?? files?.find((f) => f?.name === MANIFEST_NAME)?.content,
  );
  const manifest = validateManifest(doc);
  const checked = validateFiles(files, manifest);
  if (scope) {
    assertCoverage({
      datasets: manifest.datasets,
      venue: scope.venue,
      from: scope.from,
      to: scope.to,
    });
  }
  return {
    manifest,
    files: checked.files,
    totalBytes: checked.totalBytes,
    // What the runner has to call, in this language's spelling. Resolved here
    // so neither the runner nor the CLI re-implements the parity table.
    hookNames: Object.fromEntries(manifest.hooks.map((h) => [h, HOOK_NAMES[manifest.languageId][h]])),
    shardable: MODES[manifest.mode].shardable,
    rateMultiplier: MODES[manifest.mode].rateMultiplier,
  };
}
