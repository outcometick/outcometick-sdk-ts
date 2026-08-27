#!/usr/bin/env node
// `ot` — the command line the SDK docs tell customers to use.
//
//   ot check .                                          validate, free, no data
//   ot run . --data ./polymarket-data-samples --date …  replay locally
//   ot submit . --assets btc,eth --from … --to …        send it to the queue
//
// The one thing this file must get right is that `ot check` runs the SAME
// validator the queue runs. The docs promise "if it passes locally it will not
// be rejected on submit", and that promise only survives if there is exactly
// one implementation — so check() calls the very modules api/lib/backtest-
// routes.mjs calls, rather than reimplementing any of it.
//
// Written in Node because everything it needs already is: the contract, the
// validator, both analysers, the engine, the report and the archive writer. A
// Python submission is still run by the Python harness — the CLI spawns it the
// same way the worker does.

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

import { SDK_VERSION, LIMITS, BacktestRejection } from '../api/lib/backtest-contract.mjs';
import { checkSubmission, MANIFEST_NAME } from '../api/lib/backtest-manifest.mjs';
import { analyzeSource } from '../runner/analyze/index.mjs';

const USAGE = `ot ${SDK_VERSION} — outcometick strategy tools

  ot check <dir>
      Validate the manifest, the entry point, the hook signatures and every
      import. Touches no data and costs nothing. This is the exact validator
      the queue runs.

  ot run <dir> --data <archive> [--date <YYYY-MM-DD>] [--out <file>]
      Replay locally against a cloned sample archive, using the same engine
      the queue uses. Writes a report archive.
      Refused if the manifest declares a reference feed: those come from an
      archive held on the worker, so a local replay would hand your strategy
      empty ones. Your own CSV series work locally.

  ot submit <dir> --assets btc,eth --from <day> --to <day> [--venue polymarket]
      Send it to the queue. Needs OT_BACKTEST_KEY.
      --email <address>   have the finished report emailed to you. Without it
                          the run is only reachable from 'ot status', which
                          means remembering the id — and a queued run outlives
                          the terminal you started it from.

  ot status <run_id>
      Where a submitted run got to, and what it cost. Needs OT_BACKTEST_KEY.

  ot fetch <run_id> [--out <file>]
      Download a finished run's archive. Needs OT_BACKTEST_KEY.

  Common:
      --json          machine-readable output
      --api <url>     API base (default https://outcometick.com)

  Free sample data:
      git clone https://github.com/Ligengxin96/polymarket-data-samples
`;

/** Parse argv into {command, dir, flags}. */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const key = a.slice(2);
    // Boolean flags take no value; everything else consumes the next token.
    if (key === 'json') { flags.json = true; continue; }
    const value = rest[i + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`--${key} needs a value`);
    }
    flags[key] = value;
    i += 1;
  }
  return { command, dir: positional[0] ?? '.', flags };
}

/**
 * Read a submission directory.
 *
 * Only files the manifest could plausibly reference, and only from the top two
 * levels — a strategy directory that happens to contain a virtualenv or a
 * .git should not turn into a 400 MB submission attempt. The limits are
 * enforced properly by the validator; this is about not reading the disk.
 */
export async function readSubmission(dir) {
  const out = [];
  const walk = async (rel, depth) => {
    const entries = await readdir(path.join(dir, rel || '.'), { withFileTypes: true });
    for (const e of entries) {
      const name = rel ? `${rel}/${e.name}` : e.name;
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue;
      if (e.isDirectory()) {
        if (depth > 0) await walk(name, depth - 1);
        continue;
      }
      if (!/\.(py|mjs|js|json|csv)$/.test(e.name)) continue;
      const full = path.join(dir, name);
      const s = await stat(full);
      // The ceiling for ANY one file is the series limit, not the source limit:
      // a CSV series is allowed to be much larger than the code, and the shared
      // validator is what enforces which budget a given file falls under.
      // Refusing a 1MB CSV here meant `ot check` rejected a submission the API
      // accepts — and "a local pass is not rejected on submit" is a promise the
      // docs make.
      const ceiling = Math.max(LIMITS.maxTotalSourceBytes, LIMITS.maxSeriesBytes);
      if (s.size > ceiling) {
        throw new Error(`${name} is ${s.size} bytes, over the ${ceiling} byte limit for a single file`);
      }
      out.push({ name, content: await readFile(full, 'utf8') });
    }
  };
  await walk('', 1);
  if (!out.some((f) => f.name === MANIFEST_NAME)) {
    throw new Error(`no ${MANIFEST_NAME} in ${path.resolve(dir)}`);
  }
  return out;
}

/**
 * Validate a submission exactly as the queue would.
 *
 * `scope` is optional: coverage can only be checked against a real range, and
 * `ot check` on its own is about the manifest and the source. `ot submit`
 * passes one, and so does the API.
 */
export async function validate(files, scope = null) {
  const checked = checkSubmission({ files, scope });
  // analyzeSource, not a dispatch of our own: see runner/analyze/index.mjs for
  // why the two sides sharing this exact function is the whole promise.
  const analysis = await analyzeSource(checked);
  return { ...checked, analysis };
}

/** Print a rejection the way the docs describe the codes. */
function reportRejection(err, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: false, ...(err.toJSON?.() ?? { code: 'E_RUNTIME', detail: err.message }) })}\n`);
    return;
  }
  const code = err.code ?? 'E_RUNTIME';
  const detail = err.detail ?? err.message;
  process.stderr.write(`\n  ${code}\n  ${detail}\n\n`);
}

async function cmdCheck({ dir, flags }) {
  const files = await readSubmission(dir);
  const res = await validate(files);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      manifest: res.manifest,
      hooks: res.hookNames,
      files: res.files.map((f) => ({ name: f.name, bytes: f.bytes })),
      total_bytes: res.totalBytes,
      imports: res.analysis.imports,
    })}\n`);
    return 0;
  }
  const { manifest } = res;
  process.stdout.write(`\n  ok — ${manifest.language}, entry ${manifest.entry.file}:${manifest.entry.className}\n`);
  process.stdout.write(`  hooks     ${Object.entries(res.hookNames).map(([k, v]) => `${k} → ${v}`).join(', ')}\n`);
  process.stdout.write(`  datasets  ${manifest.datasets.join(', ')}\n`);
  // Both of these change what comes back, so `ot check` has to show them:
  // this command exists to say what the queue will do with this submission,
  // and a run narrowed to 5m at a 250ms fill delay is a different answer to
  // the same strategy.
  process.stdout.write(`  intervals ${manifest.intervals.join(', ')}\n`);
  process.stdout.write(`  delay     ${manifest.latency ? `${manifest.latency} ms` : 'none'}\n`);
  if (manifest.reference.length) process.stdout.write(`  reference ${manifest.reference.join(', ')}\n`);
  process.stdout.write(`  files     ${res.files.length} / ${LIMITS.maxFiles} · ${(res.totalBytes / 1024).toFixed(1)} / ${LIMITS.maxTotalSourceBytes / 1024} KB\n`);
  if (manifest.mode === 'session') {
    // NOT "3x the market-day rate". That multiplier was deleted, and this was
    // its third hiding place after both i18n dictionaries — the guard that
    // caught the other two only scans lib/backtest-i18n.ts.
    process.stdout.write('  mode      session — same price as market mode\n');
  }
  process.stdout.write('\n');
  return 0;
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  const { command, flags } = parsed;

  if (!command || command === 'help' || flags.help) {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }
  if (command === 'version') {
    process.stdout.write(`${SDK_VERSION}\n`);
    return 0;
  }

  try {
    if (command === 'check') return await cmdCheck(parsed);
    if (command === 'run') {
      const { cmdRun } = await import('./commands/run.mjs');
      return await cmdRun(parsed);
    }
    if (command === 'submit') {
      const { cmdSubmit } = await import('./commands/submit.mjs');
      return await cmdSubmit(parsed);
    }
    if (command === 'status') {
      const { cmdStatus } = await import('./commands/status.mjs');
      return await cmdStatus(parsed);
    }
    if (command === 'fetch') {
      const { cmdFetch } = await import('./commands/fetch.mjs');
      return await cmdFetch(parsed);
    }
    process.stderr.write(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
    return 2;
  } catch (err) {
    if (err instanceof BacktestRejection) {
      reportRejection(err, flags.json);
      return 1;
    }
    process.stderr.write(`${err.message}\n`);
    return 1;
  }
}

// Exact identity, not a suffix match. The npm package's bin shim is also called
// ot.mjs, so `endsWith('/ot.mjs')` was true when it merely IMPORTED this file —
// and the CLI ran twice, once from the shim and once from here.
const invokedDirectly = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

export { main, USAGE };
