#!/usr/bin/env node
// ot CLI.
//
//   ot check .                                     validate without data
//   ot run . --data ./polymarket-data-samples        replay locally
//   ot submit . --assets btc,eth --days 30           submit to the hosted queue
//
// Share the API validator and analysers. Python strategies use the Python harness.

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

import {
  SDK_VERSION, LIMITS, BacktestRejection, MAX_BACKTEST_DAYS,
} from '../api/lib/backtest-contract.mjs';
import { checkSubmission, MANIFEST_NAME } from '../api/lib/backtest-manifest.mjs';
import { analyzeSource } from '../runner/analyze/index.mjs';

const USAGE = `ot ${SDK_VERSION} — outcometick strategy tools

  ot init <dir> --template <id> [--lang python|nodejs]
      Start from a working strategy. \`ot init\` alone lists the templates.

  ot check <dir>
      Validate the manifest, the entry point, the hook signatures and every
      import. Touches no data and costs nothing. This is the exact validator
      the queue runs.

  ot run <dir> --data <archive> [--date <YYYY-MM-DD>] [--venue polymarket|predict] [--out <file>]
      Replay locally against a cloned sample archive, using the same engine
      the queue uses. Writes a report archive.
      --venue defaults to the venue the archive holds (polymarket if it holds
      both or neither).
      Refused if the manifest declares a reference feed: those come from an
      archive held on the worker, so a local replay would hand your strategy
      empty ones. Your own CSV series work locally.
      --cache <dir|off>   decoded days are kept (default ~/.cache/outcometick/
                          decoded-js), so the next run over the same days skips
                          decoding; keyed on every file's sha256 and the decoder
      --workers <n>       decode a day on n threads (default: every core, as
                          many as half the memory allows);
                          the events, and so the result, are the same

  ot run <dir> --data <dataset> [--mark-max-age-ms <ms>] [--out <file>]
      Your own data for ANY Polymarket binary market: a directory with
      markets.json (or .jsonl) at its top and CLOB frames in *.jsonl[.gz].
      Every market in it is replayed; an unresolved one is valued at the
      external mid when trading ends (--mark-max-age-ms refuses older quotes).

  ot fingerprint <dir> --assets btc,eth --from <day> --to <day> [--venue polymarket] [--seed 1]
                [--book-throttle on|off] [--fee-bps <n>]
  ot fingerprint <dir> --data <your-dataset> [--mark-max-age-ms <ms>]
      The run's pre-registration fingerprint, without running it: one sha256
      over the code, manifest, params, options, the days (every one of them),
      your own data's bytes, replay settings and the seed. Publish it first;
      the report of the same run carries the same value.

  ot submit <dir> --assets btc,eth --days <n> [--venue polymarket]
  ot submit <dir> --assets btc,eth --from <day> --to <day> [--venue polymarket]
      Send it to the queue. Needs OT_BACKTEST_KEY.
      --days <n>          the most recent n archived days
      Only the most recent archived days can be backtested (currently ${MAX_BACKTEST_DAYS}; the
      window moves forward daily). A --from earlier than the window, or --days
      longer than it, is refused (E_SCOPE) before anything is uploaded, with
      the current window in the message. To see it:
          curl https://outcometick.com/v1/backtest/capacity?venue=polymarket
      --email <address>   have the finished report emailed to you. Without it
                          the run is only reachable from 'ot status', which
                          means remembering the id — and a queued run outlives
                          the terminal you started it from.

  ot status <run_id>
      Where a submitted run got to, and what it cost. Needs OT_BACKTEST_KEY.

  ot fetch <run_id> [--out <file>]
      Download a finished run's archive. Needs OT_BACKTEST_KEY.

  ot mcp
      Serve the API to an AI coding tool over MCP (stdio). Reads OT_KEY for
      data tools and OT_BACKTEST_KEY for run status; never submits a run.
          claude mcp add outcometick -e OT_KEY=ck_… -- npx -y -p outcometick ot mcp

  Common:
      --json          machine-readable output
      --api <url>     API base (default https://outcometick.com)

  Free sample data:
      curl -L https://github.com/outcometick/polymarket-tick-data-samples/releases/latest/download/polymarket-data-samples.tar.gz | tar xz
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
 * Read eligible submission files from the top two directory levels. Skip
 * virtualenvs and other unrelated trees; the validator enforces file budgets.
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
      // Use the series limit as the file-read ceiling. The validator applies the
      // appropriate source or series budget afterwards.
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
  // Share analyzeSource with the server (runner/analyze/index.mjs).
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
  // Display intervals and latency because both affect replay results.
  process.stdout.write(`  intervals ${manifest.intervals.join(', ')}\n`);
  process.stdout.write(`  delay     ${manifest.latency ? `${manifest.latency} ms` : 'none'}\n`);
  if (manifest.reference.length) process.stdout.write(`  reference ${manifest.reference.join(', ')}\n`);
  process.stdout.write(`  files     ${res.files.length} / ${LIMITS.maxFiles} · ${(res.totalBytes / 1024).toFixed(1)} / ${LIMITS.maxTotalSourceBytes / 1024} KB\n`);
  if (manifest.mode === 'session') {
    // Show the server rate without an extra multiplier.
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
    if (command === 'init') {
      const { cmdInit } = await import('./commands/init.mjs');
      return await cmdInit(parsed);
    }
    if (command === 'run') {
      const { cmdRun } = await import('./commands/run.mjs');
      return await cmdRun(parsed);
    }
    if (command === 'fingerprint') {
      const { cmdFingerprint } = await import('./commands/fingerprint.mjs');
      return await cmdFingerprint(parsed);
    }
    if (command === 'submit') {
      const { cmdSubmit } = await import('./commands/submit.mjs');
      return await cmdSubmit(parsed);
    }
    if (command === 'status') {
      const { cmdStatus } = await import('./commands/status.mjs');
      return await cmdStatus(parsed);
    }
    if (command === 'mcp') {
      const { cmdMcp } = await import('./mcp.mjs');
      return await cmdMcp(parsed);
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

// Compare module URLs directly; the npm bin shim also has the name ot.mjs.
const invokedDirectly = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

export { main, USAGE };
