// `ot run` — replay locally, against a cloned sample archive.
//
// The same engine, the same harnesses, the same report and the same archive
// writer the queue uses. That is the whole point of the command: the docs
// promise "a backtest here and a backtest on your own machine after subscribing
// read the same bytes", and the only way that holds is by not having a second
// implementation of any of it.
//
// What differs from the worker: the data comes off disk instead of R2, and
// there is no container. `ot run` says so plainly rather than implying the
// isolation is the same — locally the strategy runs with the user's own
// privileges, which is fine, because it is their code on their machine.

import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LANGUAGES, HOOK_NAMES, LIMITS } from '../../api/lib/backtest-contract.mjs';
import { CHANNEL, EXIT, parseTrade, parseFill, parseResult, parseOutputLine } from '../../runner/harness/protocol.mjs';
import {
  countMarketDays, countStreams, buildCoverage, mergeReferenceRows, makeBookThrottle,
  sortMarketsForReplay,
} from '../../runner/events.mjs';
import { loadSeries } from '../../runner/series-data.mjs';
import { buildReport } from '../../runner/engine/report.mjs';
import { buildArchive } from '../../runner/archive.mjs';
import { createLineWriter } from '../../runner/stdin-writer.mjs';
import { loadLocalDay, localDays, looksLikeArchive } from '../local-data.mjs';
import { readSubmission, validate } from '../ot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, '..', '..', 'runner');

/** Run one pass of the local harness over the given markets. */
function runHarness({
  languageId, jobDir, job, markets, outputKey,
  // The submitter's own CSV, already parsed. Threaded in rather than read here
  // so it is parsed once for the whole run, exactly as the worker does.
  seriesRows = {}, seriesLags = {}, seriesNames = [],
}) {
  const cmd = languageId === 'python' ? (process.env.OT_PYTHON || 'python3') : process.execPath;
  const argv = languageId === 'python'
    ? [path.join(RUNNER, 'harness/python/harness.py'), jobDir]
    : [path.join(RUNNER, 'harness/node/harness.mjs'), jobDir];

  return new Promise((resolve, reject) => {
    // stdout is the result channel (see runner/harness/protocol.mjs), so it
    // cannot be inherited: a strategy's own output would land mid-line. The
    // harness discards that output for the same reason a container does.
    const child = spawn(cmd, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = [];
    let forged = 0;
    let tail = '';
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => {
      tail += d;
      const parts = tail.split('\n');
      tail = parts.pop();
      for (const line of parts) {
        if (!line) continue;
        const parsed = parseOutputLine(outputKey, line);
        // Counted, not shrugged off. The queued worker counts the same bytes as
        // forged, and a stray write between two real lines corrupts the one
        // after it — so a local replay that quietly drops them can hand back a
        // report the queued run would never have produced. Silence here is the
        // exact shape of the divergence this CLI exists to rule out.
        if (parsed) lines.push(parsed);
        else forged += 1;
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      // A short feed that still exited 0 is the dangerous case: the harness
      // replayed whatever reached it, reported cleanly, and the report looks
      // complete. It must not be resolved as a successful run. When the harness
      // died first the pipe breaks as a CONSEQUENCE, and its own exit code and
      // stderr say more than the EPIPE does — so let that path through
      // unchanged and let the caller report the real failure.
      if (streamError && code === EXIT.ok) { reject(streamError); return; }
      resolve({ code, stderr, lines, forged });
    });

    // THE SAME writer the queue uses (runner/stdin-writer.mjs). This loop used
    // to ignore what write() returned and swallow every stdin error, so once
    // the pipe's buffer filled the rows simply stopped arriving: a 289-market
    // day came back as a 2-market report, exit 0, no warning. `ot run` and the
    // worker have drifted eight times; sharing the writer is how this one stops
    // being a ninth.
    let streamError = null;
    const write = createLineWriter(child.stdin);
    (async () => {
      await write(JSON.stringify({ ...job, outputKey }));
      for (const m of markets) {
        // Series rows are INTERLEAVED into the same stream in event time,
        // exactly as the worker sends them — and `lags` travels with them, or a
        // signal that declared a publication delay would be visible the instant
        // its row was stamped rather than when it could have existed.
        const lines = m.events.map((ev) => JSON.stringify(ev));
        const merged = seriesNames.length
          ? mergeReferenceRows(lines, seriesRows, m.market, 'ext', seriesLags)
          : lines;
        await write(JSON.stringify({
          market: m.market,
          stream: m.stream,
          n: merged.length,
          ...(seriesNames.length ? { series: seriesNames } : {}),
          ...(Object.keys(seriesLags).length ? { lags: seriesLags } : {}),
        }));
        for (const line of merged) await write(line);
      }
      child.stdin.end();
    })().catch((err) => {
      streamError = err;
      child.stdin.destroy();
    });
  });
}

function demux(lines) {
  const trades = [];
  const fills = [];
  const logs = [];
  // Counted, not swallowed. The queue publishes `dropped_rows`, and a local run
  // that discarded the same rows in silence reported a clean report over the
  // identical archive — the number exists precisely so a customer can tell that
  // something did not parse.
  let malformed = 0;
  let result = parseResult({});
  for (const { channel, payload } of lines) {
    if (channel === CHANNEL.log) { logs.push(payload); continue; }
    if (channel === CHANNEL.progress) continue;
    if (channel === CHANNEL.result) {
      try { result = parseResult(JSON.parse(payload)); } catch { malformed += 1; }
      continue;
    }
    let raw;
    try { raw = JSON.parse(payload); } catch { malformed += 1; continue; }
    const row = channel === CHANNEL.trade ? parseTrade(raw) : parseFill(raw);
    if (!row) { malformed += 1; continue; }
    (channel === CHANNEL.trade ? trades : fills).push(row);
  }
  return { trades, fills, logs: logs.join('\n'), result, malformed };
}

export async function cmdRun({ dir, flags }) {
  const dataRoot = flags.data;
  if (!dataRoot) {
    throw new Error('--data is required: point it at an unpacked sample archive\n'
      + '  curl -L https://github.com/Ligengxin96/polymarket-data-samples/releases/latest/download/polymarket-data-samples.tar.gz | tar xz');
  }
  if (!await looksLikeArchive(dataRoot)) {
    throw new Error(`${path.resolve(dataRoot)} does not look like an archive — no recognisable data files under it\n`
      + '  the sample archive is a release download, not the git repository:\n'
      + '  curl -L https://github.com/Ligengxin96/polymarket-data-samples/releases/latest/download/polymarket-data-samples.tar.gz | tar xz');
  }

  const files = await readSubmission(dir);
  const checked = await validate(files);
  const { manifest } = checked;
  const languageId = manifest.languageId;

  const available = await localDays(dataRoot);
  if (available.length === 0) throw new Error(`no dated files under ${path.resolve(dataRoot)}`);
  const days = flags.date ? [flags.date] : available;
  const unknown = days.filter((d) => !available.includes(d));
  if (unknown.length) {
    throw new Error(`${unknown.join(', ')} not in ${path.resolve(dataRoot)} — it holds ${available[0]}..${available[available.length - 1]}`);
  }

  // REFERENCE FEEDS ARE REFUSED. SERIES ARE NOT.
  //
  // The distinction is where the data lives, and it took a review to get right:
  // a reference feed is the Binance archive, which sits on the worker's own disk
  // and was deliberately never put in R2 — no local run can reach it. A series
  // is the submitter's own CSV, and it is right here in the directory being run.
  //
  // Refusing both was the safe-looking answer and the wrong one: it would have
  // forced every strategy using `ctx.ext()` to spend credits in the queue to
  // discover a runtime mistake it could have found locally in a second. What
  // must not happen is running with an EMPTY feed, which produces a report that
  // looks comparable to the queued one and is not.
  const refs = (manifest.reference ?? []).map((r) => (typeof r === 'string' ? r : r.name));
  if (refs.length) {
    throw new Error(
      `this manifest declares reference feeds a local replay cannot supply:\n    ${refs.join('\n    ')}\n`
      + '  They come from an archive held on the worker, so `ot run` would hand\n'
      + '  your strategy empty feeds and a report that does not match the queued\n'
      + '  one. Submit it instead:\n'
      + '    ot submit .  --assets btc --range "30 days"',
    );
  }

  // The submitter's own CSV, parsed by the SAME reader the queue uses, so a
  // header it would reject there is rejected here too.
  const seriesRows = manifest.series?.length
    ? loadSeries(manifest.series, checked.files)
    : { rowsByName: {}, problems: [] };
  const fatalSeries = (seriesRows.problems ?? []).filter((x) => x.fatal !== false);
  if (fatalSeries.length) {
    throw new Error(`series could not be read:\n    ${
      fatalSeries.map((x) => `${x.name} (${x.file}): ${x.problem}`).join('\n    ')}`);
  }
  const seriesLags = Object.fromEntries(
    (manifest.series ?? []).filter((x) => x.lag_ms > 0).map((x) => [x.name, x.lag_ms]),
  );
  const seriesNames = Object.keys(seriesRows.rowsByName ?? {});

  const venue = flags.venue ?? 'polymarket';
  const assets = (flags.assets ?? '').split(',').map((a) => a.trim().toUpperCase()).filter(Boolean);

  const markets = [];
  // Gaps are part of the answer, not noise to drop.
  //
  // A queued run's coverage names every market it could not use; a local run
  // reading the same archive said nothing, so the two disagreed about what had
  // been covered while agreeing about everything else. That is the harder
  // discrepancy to notice, because the report looks complete.
  const missing = [];
  for (const day of days) {
    const loaded = await loadLocalDay({
      root: dataRoot, day, venue,
      assets: assets.length ? assets : ['BTC', 'ETH', 'SOL', 'XRP'],
      datasets: manifest.datasets,
      intervals: manifest.intervals,
      // The SAME cadence the queue would replay this range at — built from the
      // whole range, not this day, so an asset's density never changes partway
      // through a run. Per asset, not run-wide: see makeBookThrottle.
      throttle: makeBookThrottle({
        venue,
        assets: assets.length ? assets : ['BTC', 'ETH', 'SOL', 'XRP'],
        from: days[0],
        to: days[days.length - 1],
      }),
    });
    if (loaded.markets.length === 0) {
      process.stderr.write(`  ${day}: ${loaded.reason}\n`);
      missing.push({
        day,
        reason: loaded.reason ?? 'no markets',
        ...(loaded.unusable?.length
          ? {
            partial: false,
            markets: loaded.unusable.length,
            dropped: loaded.unusable.slice(0, 10),
            reasons: [...new Set(loaded.unusable.map((u) => u.why))],
          }
          : {}),
      });
      continue;
    }
    if (loaded.unusable?.length) {
      const why = `${loaded.unusable.length} market(s) dropped: ${loaded.unusable[0].why}`;
      process.stderr.write(`  ${day}: ${why}\n`);
      missing.push({
        day, partial: true, markets: loaded.unusable.length, reason: why,
        // Same bound the queue applies — see MAX_DROPPED_LISTED there.
        dropped: loaded.unusable.slice(0, 10),
        ...(loaded.unusable.length > 10
          ? { dropped_truncated: loaded.unusable.length - 10 } : {}),
        reasons: [...new Set(loaded.unusable.map((u) => u.why))],
      });
    }
    markets.push(...loaded.markets);
  }
  if (markets.length === 0) throw new Error('no market-days could be read from that archive');
  // SESSION IS ONE STREAM ACROSS THE RANGE, so it is ordered once over every
  // day — the same thing fetchMarketDays does for the queue. Ordering it a day
  // at a time leaves the stream day-major, which is chronological only by
  // accident and stops being so as soon as two assets are in scope. Session
  // shares one Portfolio across every market, so this is part of the ANSWER,
  // not of the log.
  if ((manifest.mode ?? 'market') === 'session') {
    sortMarketsForReplay(markets, { mode: 'session' });
  }
  // ONE ASSET ON ONE UTC DAY — the unit the queue bills in. `markets` is one
  // entry per market, and a day of BTC 15-minute markets is ninety-six of them,
  // so counting entries reported a run as being a hundred times bigger than the
  // customer is charged for and disagreed with the queue's own coverage.
  const marketDaysScanned = countMarketDays(markets);

  const jobDir = await mkdtemp(path.join(tmpdir(), 'ot-run-'));
  try {
    const src = path.join(jobDir, 'src');
    await mkdir(src, { recursive: true });
    for (const f of checked.files) {
      const dest = path.resolve(src, f.name);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, f.content);
    }
    // The SDK has to be resolvable exactly as it is in the image, or the
    // documented `import … from "outcometick"` fails locally and works remotely.
    if (languageId === 'nodejs') {
      const { cp } = await import('node:fs/promises');
      await cp(path.join(RUNNER, 'harness/node/sdk'),
        path.join(jobDir, 'node_modules', 'outcometick'), { recursive: true });
    }

    const baseJob = {
      entry: manifest.entry,
      hooks: Object.fromEntries(manifest.hooks.map((h) => [h, HOOK_NAMES[languageId][h]])),
      arities: { on_market_open: 3, on_tick: 3, on_book: 3, on_trade: 3, on_settle: 4 },
      params: manifest.params,
      mode: manifest.mode,
      seed: Number(flags.seed ?? 1),
      feeBps: Number(flags['fee-bps'] ?? 0),
      limits: LIMITS,
    };
    if (languageId === 'python') {
      process.env.PYTHONPATH = [path.join(RUNNER, 'harness/python'), process.env.PYTHONPATH]
        .filter(Boolean).join(path.delimiter);
    }

    if (!flags.json) {
      process.stdout.write(`\n  ${marketDaysScanned} market-days · ${manifest.language} · local replay\n`);
    }

    const passes = [];
    // ONE pass, at whatever delay the manifest asked for — the same shape the
    // queue runs (runner/worker.mjs). These two have drifted eight times and
    // every one was "we shared the decoder and nothing else".
    const delayMs = manifest.latency ?? 0;
    const steps = [{ label: delayMs ? `+${delayMs} ms` : '0 ms', ms: delayMs }];
    for (const step of steps) {
      const outputKey = randomBytes(32).toString('hex');
      const res = await runHarness({
        languageId, jobDir, outputKey, markets,
        job: { ...baseJob, fillDelayMs: step.ms },
        seriesRows: seriesRows.rowsByName ?? {}, seriesLags, seriesNames,
      });
      const out = demux(res.lines);
      if (res.forged > 0) {
        // Almost always a dependency writing to stdout: the harness takes
        // console away from the strategy before loading it, but a library that
        // reaches the descriptor another way still lands on the channel.
        const err = new Error(
          `${res.forged} line(s) on the result channel did not authenticate.`
          + ' Something in this strategy or its dependencies writes to stdout;'
          + ' a queued run would count the same bytes as forged and could lose'
          + ' results. Use ctx.log() for output.',
        );
        err.code = 'E_RUNTIME';
        err.detail = err.message;
        throw err;
      }
      // UNCONDITIONAL. This used to be wrapped in `if (step.ms === 0)`, from
      // when pass 0 was the report and the rest were a comparison curve whose
      // failures were survivable. There is one pass now, and its delay is
      // whatever the manifest asked for — so the guard silently stopped
      // running the moment anyone wrote `latency: 250`, and a rejected or
      // over-budget replay became a report: locally successful, marked
      // `fill_delay_ms: 250`, and refused by the queue.
      if (res.code === EXIT.rejected || res.code === EXIT.budget) {
        const r = out.result.rejection ?? { code: 'E_RUNTIME', detail: res.stderr.slice(0, 2000) };
        const err = new Error(r.detail);
        err.code = r.code;
        err.detail = r.detail;
        throw err;
      }
      if (res.code !== EXIT.ok) throw new Error(res.stderr.slice(0, 2000) || `harness exited ${res.code}`);
      passes.push({ delayMs: step.ms, ...out, ok: res.code === EXIT.ok });
    }

    const base = passes[0];
    // A SHORT REPLAY MUST FAIL EVEN WHEN NOTHING REPORTED AN ERROR.
    //
    // The backpressure bug produced exactly that shape: every write "succeeded",
    // the harness exited 0, and 2 of 289 markets came back as a clean, complete
    // looking report. Fixing the writer closes the cause we found; counting what
    // came back is what catches the next one, whatever it turns out to be.
    //
    // `markets_run` is incremented by the harness only after a market is fully
    // replayed, so on a clean exit it equals what was fed. A rejected or
    // over-budget run never reaches here — those exit non-zero and are raised
    // above with the sandbox's own reason, which says more than this count.
    if (base.result.marketsRun < markets.length) {
      const err = new Error(
        `only ${base.result.marketsRun} of ${markets.length} market(s) were replayed —`
        + ' the report would be incomplete, so none was written.'
        + ' This usually means the feed to the runner was cut short.',
      );
      err.code = 'E_RUNTIME';
      err.detail = err.message;
      throw err;
    }
    const marketMeta = new Map(markets.map((m) => [m.market.market_id, {
      market_id: m.market.market_id,
      asset: m.market.asset,
      interval: m.market.interval,
      outcome: m.market.outcome,
      up_px: m.up_px,
      down_px: m.down_px,
      stream: m.stream,
    }]));

    const report = buildReport({
      runId: `local_${days[0]}`,
      submittedAt: 0,
      manifest,
      // Local runs have no stored submission to hash, and saying null is
      // truthful: this report is not tied to a submission at all.
      sourceSha256: null,
      scope: {
        venue,
        assets: assets.length ? assets : [...new Set(markets.map((m) => m.market.asset).filter(Boolean))],
        from: days[0],
        to: days[days.length - 1],
        marketDays: marketDaysScanned,
        archivedDayCount: days.length,
      },
      scanned: {
        markets: base.result.marketsRun,
        market_days: marketDaysScanned,
        events: base.result.eventsSeen,
      },
      trades: base.trades,
      fills: base.fills,
      marketSummaries: [...marketMeta.values()],
      marketMeta,
      feesPaid: base.result.feesPaid,
      fillDelayMs: delayMs,
      sweep: null,
      crosschecks: base.result.crosschecks,
      seed: Number(flags.seed ?? 1),
      coverage: buildCoverage({
        marketDaysScanned,
        // NOT backfilled from `scanned`. Filling it in that way meant the
        // headline always said "asked for N, scanned N" — so a day that was
        // entirely unusable was recorded in `missing` and simultaneously denied
        // at the top of the same file. A local run does not know what was asked
        // for; null says that, and saying it is the point.
        marketDaysRequested: null,
        marketsReportedByRunner: base.result.marketsRun,
        missing,
        // Always empty here: a manifest that declares one is refused above,
        // because a local replay cannot supply it.
        referenceDeclared: [],
        streams: countStreams([...marketMeta.values()]),
        droppedRows: base.malformed ?? 0,
        local: true,
        source: path.resolve(dataRoot),
      }),
      budget: base.result.budget,
    });

    if (flags.json) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else {
      const m = report.metrics;
      const money = (v) => (v == null ? '—' : `${v < 0 ? '-' : '+'}$${Math.abs(v).toLocaleString()}`);
      process.stdout.write(`\n  net pnl        ${money(m.net_pnl)}\n`);
      process.stdout.write(`  trades         ${m.trades}\n`);
      process.stdout.write(`  win rate       ${m.win_rate == null ? '—' : `${(m.win_rate * 100).toFixed(1)}%`}\n`);
      process.stdout.write(`  brier          ${m.brier_score ?? '—'}\n`);
      process.stdout.write(`  edge/contract  ${m.edge_per_contract == null ? '—' : `${(m.edge_per_contract * 100).toFixed(1)}¢`}\n`);
      process.stdout.write(`  fees           ${money(m.fees)}\n`);
      if (report.slippage.pnl_lost_to_slippage != null) {
        process.stdout.write(`  lost to slip   ${money(report.slippage.pnl_lost_to_slippage)}\n`);
      }
      process.stdout.write('\n  This is a LOCAL replay: no container, your own privileges, sample data.\n');
    }

    const outFile = flags.out ?? `${path.basename(path.resolve(dir))}-local.zip`;
    const zip = await buildArchive({
      runId: report.run_id,
      report,
      trades: base.trades,
      fills: base.fills,
      logs: base.logs,
      source: checked.files,
    });
    await writeFile(outFile, zip);
    if (!flags.json) process.stdout.write(`  archive        ${outFile} (${(zip.length / 1024).toFixed(0)} KB)\n\n`);
    return 0;
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
}

export { LANGUAGES };
