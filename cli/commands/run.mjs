// Replay a local archive with the hosted engine, harnesses and report writer.
// Data comes from disk. Strategies run without a container, with local privileges.

import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { availableParallelism, tmpdir, totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LANGUAGES, HOOK_NAMES, LIMITS } from '../../api/lib/backtest-contract.mjs';
import { CHANNEL, EXIT, parseTrade, parseFill, parseResult, parseOutputLine, parseRecord, MAX_RECORD_ROWS } from '../../runner/harness/protocol.mjs';
import {
  countMarketDays, countStreams, buildCoverage, bboCoverage, mergeReferenceRows, makeBookThrottle,
  sortMarketsForReplay,
} from '../../runner/events.mjs';
import { loadSeries } from '../../runner/series-data.mjs';
import { buildReport, fillStats, marketRows, feeModelReport, makerReport, ordersReport, recordReport } from '../../runner/engine/report.mjs';
import { queueModelName, PRINT_LAG_MS } from '../../runner/engine/maker.mjs';
import { sessionLines } from '../../runner/session-feed.mjs';
import { feePolicyFor, restingPolicyFor, enginePolicyFor } from '../../api/lib/backtest-datasets.mjs';
import { fingerprintOfFiles, datasetDigest, localInputs } from '../../api/lib/backtest-fingerprint.mjs';
import { buildArchive } from '../../runner/archive.mjs';
import { createLineWriter } from '../../runner/stdin-writer.mjs';
import { readEventLines } from '../../runner/spool-day.mjs';
import { decoderDigest, defaultCacheRoot, loadLocalDayCached } from '../decode-cache.mjs';
import { defaultDecodeWorkers } from '../parallel-decode.mjs';
import {
  loadLocalDay, localDays, looksLikeArchive, archiveVenues, defaultVenue,
} from '../local-data.mjs';
import { readSubmission, validate } from '../ot.mjs';
import { looksLikeGenericDataset, decodeGenericDir, fileLines, datasetFiles, marketsFileOf } from '../../runner/generic-data.mjs';
import { genericReportExtras, applyGenericExtras } from '../../runner/generic-report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, '..', '..', 'runner');

/** Run one pass of the local harness over the given markets. */
function runHarness({
  languageId, jobDir, job, markets, outputKey, eventsDir,
  // Parse the strategy's CSV once for the run, as the hosted worker does.
  seriesRows = {}, seriesLags = {}, seriesNames = [],
}) {
  const cmd = languageId === 'python' ? (process.env.OT_PYTHON || 'python3') : process.execPath;
  const argv = languageId === 'python'
    ? [path.join(RUNNER, 'harness/python/harness.py'), jobDir]
    : [path.join(RUNNER, 'harness/node/harness.mjs'), jobDir];

  return new Promise((resolve, reject) => {
    // stdout carries protocol results; strategy output would corrupt the stream.
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
        // Count malformed output as forged bytes, as the hosted worker does.
        if (parsed) lines.push(parsed);
        else forged += 1;
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      // A truncated feed with exit code 0 is a failed run. For a nonzero exit,
      // preserve the harness error rather than masking it with EPIPE.
      if (streamError && code === EXIT.ok) { reject(streamError); return; }
      resolve({ code, stderr, lines, forged });
    });

    // Share the backpressure-aware writer with the hosted worker.
    let streamError = null;
    const write = createLineWriter(child.stdin);
    // Interleave series rows in event time, including their publication lags.
    // Read spooled events one market at a time; stream generic markets, which
    // can span months.
    const cursorOf = (m) => fileLines(path.resolve(eventsDir, m.eventsFile));
    const linesOf = async (m) => {
      const lines = await readEventLines(path.resolve(eventsDir, m.eventsFile));
      return seriesNames.length
        ? mergeReferenceRows(lines, seriesRows, m.market, 'ext', seriesLags)
        : lines;
    };
    // The recorder keys samples by the market's place in the run (record_ms).
    const instanceOf = job.engine?.record_ms ? new Map(markets.map((m, i) => [m, i])) : null;
    const headerOf = (m) => ({
      market: m.market,
      stream: m.stream,
      ...(instanceOf ? { instance: instanceOf.get(m) } : {}),
      ...(m.market?.kind === 'generic' ? { terminal: m.terminal ?? null } : {}),
      ...(seriesNames.length ? { series: seriesNames } : {}),
      ...(Object.keys(seriesLags).length ? { lags: seriesLags } : {}),
    });
    (async () => {
      await write(JSON.stringify({ ...job, outputKey }));
      if (job.mode === 'session') {
        // Merge markets in time order using runner/session-feed.mjs.
        for await (const line of sessionLines(markets, { linesOf, headerOf, cursorOf, timed: job.engine?.scheduler === 'global' })) await write(line);
      } else {
        for (const m of markets) {
          if (m.market?.kind === 'generic') {
            await write(JSON.stringify({ ...headerOf(m), n: m.n }));
            for await (const line of cursorOf(m)) await write(line);
            continue;
          }
          const merged = await linesOf(m);
          await write(JSON.stringify({ ...headerOf(m), n: merged.length }));
          for (const line of merged) await write(line);
        }
      }
      // Through the writer, which flushes its last batch first.
      await write.end();
    })().catch((err) => {
      streamError = err;
      child.stdin.destroy();
    });
  });
}

function demux(lines) {
  const trades = [];
  const fills = [];
  const records = [];
  const logs = [];
  // Include dropped_rows in local reports, as in hosted reports.
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
    if (channel === CHANNEL.record) {
      const rec = parseRecord(raw);
      if (rec) records.push(rec); else malformed += 1;
      continue;
    }
    const row = channel === CHANNEL.trade ? parseTrade(raw) : parseFill(raw);
    if (!row) { malformed += 1; continue; }
    (channel === CHANNEL.trade ? trades : fills).push(row);
  }
  return { trades, fills, records, logs: logs.join('\n'), result, malformed };
}

export async function cmdRun({ dir, flags }) {
  const dataRoot = flags.data;
  if (!dataRoot) {
    throw new Error('--data is required: point it at an unpacked sample archive\n'
      + '  curl -L https://github.com/outcometick/polymarket-tick-data-samples/releases/latest/download/polymarket-data-samples.tar.gz | tar xz');
  }
  // A directory with a markets file at its top is the user's own data for any
  // binary market (runner/generic-data.mjs), not the outcometick archive.
  const generic = await looksLikeGenericDataset(dataRoot);
  if (!generic && !await looksLikeArchive(dataRoot)) {
    throw new Error(`${path.resolve(dataRoot)} does not look like an archive — no recognisable data files under it\n`
      + '  the sample archive is a release download, not the git repository:\n'
      + '  curl -L https://github.com/outcometick/polymarket-tick-data-samples/releases/latest/download/polymarket-data-samples.tar.gz | tar xz');
  }

  const files = await readSubmission(dir);
  const checked = await validate(files);
  const { manifest } = checked;
  const languageId = manifest.languageId;

  if (!generic && flags['mark-max-age-ms'] != null) {
    throw new Error('--mark-max-age-ms applies to generic data only: archive markets settle on their official outcome');
  }
  if (generic && flags.date) {
    throw new Error('--date selects archive days; generic data has no days — every market in the dataset is replayed');
  }
  const available = generic ? [] : await localDays(dataRoot);
  if (!generic && available.length === 0) throw new Error(`no dated files under ${path.resolve(dataRoot)}`);
  const days = generic ? [] : (flags.date ? [flags.date] : available);
  const unknown = days.filter((d) => !available.includes(d));
  if (unknown.length) {
    throw new Error(`${unknown.join(', ')} not in ${path.resolve(dataRoot)} — it holds ${available[0]}..${available[available.length - 1]}`);
  }

  // Reference feeds live on the hosted worker and are unavailable locally.
  // Strategy CSV series are local and supported. Reject missing feeds rather
  // than replaying with empty input.
  const refs = (manifest.reference ?? []).map((r) => (typeof r === 'string' ? r : r.name));
  if (refs.length) {
    throw new Error(
      `this manifest declares reference feeds a local replay cannot supply:\n    ${refs.join('\n    ')}\n`
      + '  They come from an archive held on the worker, so `ot run` would hand\n'
      + '  your strategy empty feeds and a report that does not match the queued\n'
      + '  one. Submit it instead:\n'
      + '    ot submit . --assets btc --days 20',
    );
  }

  // Use the hosted CSV reader so header validation agrees.
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
  if (generic && seriesNames.length) {
    throw new Error('series are not supported with generic data yet — run without `series` in the manifest');
  }

  // Inferred from the archive when not given: see defaultVenue.
  if (generic && flags.venue && flags.venue !== 'polymarket') {
    throw new Error('generic data is Polymarket CLOB data; --venue must be polymarket or omitted');
  }
  // A generic dataset holds no archive files, so this is polymarket for it.
  const venue = flags.venue ?? defaultVenue(await archiveVenues(dataRoot));

  // Execution options (fok, order rules, quote guard, maker rebate, mirror
  // depth): one decision for the run, the same function the worker calls.
  const enginePolicy = enginePolicyFor({ manifest, venue, data: generic ? 'generic' : 'archive' });

  // Local book thinning can be disabled. Record the applied setting.
  const throttleFlag = flags['book-throttle'];
  if (throttleFlag != null && throttleFlag !== 'on' && throttleFlag !== 'off') {
    throw new Error(`--book-throttle must be on or off, got ${throttleFlag}`);
  }
  if (generic && throttleFlag != null) {
    throw new Error('--book-throttle applies to the archive; your own data is never thinned');
  }
  const assets = (flags.assets ?? '').split(',').map((a) => a.trim().toUpperCase()).filter(Boolean);

  const markets = [];
  // Include unusable markets in coverage. Spool each market to its own file
  // and remove the temporary directory on every exit path.
  const eventsDir = await mkdtemp(path.join(tmpdir(), 'ot-events-'));
  try {
    const missing = [];
    const bboApplied = new Map();  // day -> Set('<ASSET>|<interval>')
    let genericDecoded = null;
    if (generic) {
      const markAge = flags['mark-max-age-ms'];
      if (markAge != null && !/^[0-9]+$/.test(markAge)) {
        throw new Error(`--mark-max-age-ms must be a whole number of milliseconds, got ${markAge}`);
      }
      genericDecoded = await decodeGenericDir(dataRoot, {
        eventsDir,
        markMaxAgeMs: markAge == null ? null : Number(markAge),
        orderRules: enginePolicy?.order_rules?.mode === 'venue',
      });
      for (const u of genericDecoded.unusable) process.stderr.write(`  ${u.market_id ?? '?'}: ${u.why}\n`);
      markets.push(...genericDecoded.markets);
    }
    const runInputs = [];
    // Limit decode threads to half the available memory unless --workers is set.
    // cli/parallel-decode.mjs preserves sequential output.
    const decodeWorkers = flags.workers == null
      ? defaultDecodeWorkers({ cores: availableParallelism(), totalBytes: totalmem() })
      : Number(flags.workers);
    if (!Number.isInteger(decodeWorkers) || decodeWorkers < 1) {
      throw new Error(`--workers must be a whole number from 1, got ${flags.workers}`);
    }
    // Decoded days are kept (cli/decode-cache.mjs) unless --cache off.
    const cacheFlag = flags.cache;
    const cacheRoot = cacheFlag === 'off' ? null : path.resolve(cacheFlag ?? defaultCacheRoot());
    const decoder = cacheRoot && !generic ? await decoderDigest() : null;
    for (const day of days) {
      // Choose per-asset cadence from the whole range. Each decode gets a fresh
      // stateful throttle so earlier days cannot affect the rows it keeps.
      const newThrottle = throttleFlag === 'off' ? null : () => makeBookThrottle({
        venue,
        assets: assets.length ? assets : ['BTC', 'ETH', 'SOL', 'XRP'],
        from: days[0],
        to: days[days.length - 1],
      });
      const request = {
        root: dataRoot, day, venue, eventsDir, workers: decodeWorkers,
        assets: assets.length ? assets : ['BTC', 'ETH', 'SOL', 'XRP'],
        datasets: manifest.datasets,
        intervals: manifest.intervals,
      };
      const loaded = cacheRoot
        ? await loadLocalDayCached({ ...request, cacheRoot, decoder, newThrottle })
        : await loadLocalDay({ ...request, throttle: newThrottle ? newThrottle() : null });
      // Track top-of-book coverage by market-day and files for inputs_sha256.
      runInputs.push(...(loaded.inputs ?? []));
      if (loaded.bboKeys?.length) {
        const acc = bboApplied.get(day) ?? new Set();
        for (const k of loaded.bboKeys) acc.add(k);
        bboApplied.set(day, acc);
      }
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
          // Same bound the queue applies; see MAX_DROPPED_LISTED there.
          dropped: loaded.unusable.slice(0, 10),
          ...(loaded.unusable.length > 10
            ? { dropped_truncated: loaded.unusable.length - 10 } : {}),
          reasons: [...new Set(loaded.unusable.map((u) => u.why))],
        });
      }
      markets.push(...loaded.markets);
    }
    if (markets.length === 0) {
      throw new Error(generic ? 'no market of that dataset could be replayed (reasons above)' : 'no market-days could be read from that archive');
    }
    // Session mode shares a portfolio across markets. Sort across the whole
    // range; day-major order is not chronological when markets overlap.
    if ((manifest.mode ?? 'market') === 'session') {
      sortMarketsForReplay(markets, { mode: 'session' });
    }
    // Count archive coverage by asset and UTC day, not by individual market.
    // Generic data is counted by market.
    const marketDaysScanned = generic ? markets.length : countMarketDays(markets);

    const jobDir = await mkdtemp(path.join(tmpdir(), 'ot-run-'));
    try {
      const src = path.join(jobDir, 'src');
      await mkdir(src, { recursive: true });
      for (const f of checked.files) {
        const dest = path.resolve(src, f.name);
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, f.content);
      }
      // Resolve SDK imports as in the sandbox image.
      if (languageId === 'nodejs') {
        const { cp } = await import('node:fs/promises');
        await cp(path.join(RUNNER, 'harness/node/sdk'),
          path.join(jobDir, 'node_modules', 'outcometick'), { recursive: true });
      }

      const feePolicy = feePolicyFor({ manifest, envFeeBps: flags['fee-bps'] ?? null });
      const baseJob = {
        entry: manifest.entry,
        hooks: Object.fromEntries(manifest.hooks.map((h) => [h, HOOK_NAMES[languageId][h]])),
        arities: { on_market_open: 3, on_tick: 3, on_book: 3, on_trade: 3, on_settle: 4, on_timer: 3 },
        params: manifest.params,
        mode: manifest.mode,
        seed: Number(flags.seed ?? 1),
        // The venue's own schedule, market by market, unless the manifest or
        // --fee-bps says otherwise; the same rule the worker applies.
        fees: feePolicy,
        // Same rule as the worker: Polymarket with book + trades declared.
        resting: restingPolicyFor({ manifest, venue }),
        ...(enginePolicy ? { engine: enginePolicy } : {}),
        // Same rule as the worker: absent unless the spot dataset is declared.
        ...((manifest.datasets ?? []).includes('spot') ? { spot: true } : {}),
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
      // Run one pass at the manifest delay, as runner/worker.mjs does.
      const delayMs = manifest.latency ?? 0;
      const steps = [{ label: delayMs ? `+${delayMs} ms` : '0 ms', ms: delayMs }];
      for (const step of steps) {
        const outputKey = randomBytes(32).toString('hex');
        const res = await runHarness({
          languageId, jobDir, outputKey, markets, eventsDir,
          job: { ...baseJob, fillDelayMs: step.ms },
          seriesRows: seriesRows.rowsByName ?? {}, seriesLags, seriesNames,
        });
        const out = demux(res.lines);
        if (res.forged > 0) {
          // Libraries can bypass redirected console output and write to stdout.
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
        // Validate the single replay pass at any configured delay.
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
      // On a clean exit, markets_run counts fully replayed markets and must
      // equal the number fed. Nonzero exits were handled above.
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
        open_ts_ms: m.market.open_ts_ms ?? null,
        close_ts_ms: m.market.close_ts_ms ?? null,
        strike: m.market.strike ?? null,
        up_px: m.up_px,
        down_px: m.down_px,
        stream: m.stream,
      }]));

      const localMarkets = marketRows(base.trades, marketMeta);
      const fillSummary = fillStats(base.fills);
      // The time-grid mark-to-market, when the manifest asked for it (record_ms).
      const rec = recordReport({
        samples: base.records ?? [], recordMs: enginePolicy?.record_ms ?? null, harness: base.result.record,
        maxRows: MAX_RECORD_ROWS,
      });
      let report = buildReport({
        runId: generic ? 'local_generic' : `local_${days[0]}`,
        submittedAt: 0,
        manifest,
        // Local runs have no stored submission to hash.
        sourceSha256: null,
        fingerprint: fingerprintOfFiles(files, {
          // Your own data has no archive scope: its bytes are its scope.
          scope: generic ? { venue: 'polymarket', assets: [], days: [] } : {
            venue,
            assets: assets.length ? assets : [...new Set(markets.map((m) => m.market.asset).filter(Boolean))],
            days,
          },
          seed: Number(flags.seed ?? 1),
          data: generic ? 'generic' : 'archive',
          dataSha256: generic
            ? await datasetDigest(dataRoot, { marketsFile: await marketsFileOf(dataRoot), files: await datasetFiles(dataRoot) })
            : null,
          replay: {
            bookThrottle: throttleFlag !== 'off',
            markMaxAgeMs: flags['mark-max-age-ms'] == null ? null : Number(flags['mark-max-age-ms']),
          },
          inputs: generic ? null : await localInputs(dataRoot, runInputs),
          feeBpsOverride: (() => { const v = Number(flags['fee-bps']); return flags['fee-bps'] != null && flags['fee-bps'] !== '' && Number.isFinite(v) && v >= 0 ? v : null; })(),
        }),
        scope: {
          venue,
          assets: assets.length ? assets : [...new Set(markets.map((m) => m.market.asset).filter(Boolean))],
          from: days[0],
          to: days[days.length - 1],
          marketDays: marketDaysScanned,
          // Use market-days, matching hosted metrics.market_days.
          archivedDayCount: marketDaysScanned,
        },
        scanned: {
          markets: base.result.marketsRun,
          market_days: marketDaysScanned,
          events: base.result.eventsSeen,
        },
        trades: base.trades,
        fillStats: fillSummary,
        maker: makerReport({
          stats: base.result.maker, fills: fillSummary.makerFills, queueModel: queueModelName(enginePolicy?.queue_prob), queueProb: enginePolicy?.queue_prob ?? null, printLagMs: PRINT_LAG_MS,
        }),
        orders: ordersReport({ policy: enginePolicy, stats: base.result.orders }),
        timers: enginePolicy?.timers ? base.result.timers : null,
        record: rec.block,
        spot: (manifest.datasets ?? []).includes('spot') ? base.result.spot : null,
        marketSummaries: [...marketMeta.values()],
        marketMeta,
        feesPaid: base.result.feesPaid,
        fillDelayMs: delayMs,
        feeModel: feeModelReport({ policy: feePolicy, markets: markets.map((m) => m.market) }),
        sweep: null,
        crosschecks: base.result.crosschecks,
        seed: Number(flags.seed ?? 1),
        coverage: buildCoverage({
          marketDaysScanned,
          // The requested count is unknown locally; do not infer it from scanned.
          marketDaysRequested: null,
          marketsReportedByRunner: base.result.marketsRun,
          missing,
          // Always empty here: a manifest that declares one is refused above,
          // because a local replay cannot supply it.
          referenceDeclared: [],
          streams: countStreams([...marketMeta.values()]),
          droppedRows: base.malformed ?? 0,
          ...bboCoverage({ venue, datasets: manifest.datasets, markets, applied: bboApplied }),
          local: true,
          source: path.resolve(dataRoot),
        }),
        budget: base.result.budget,
      });
      if (throttleFlag != null && report.coverage) {
        // What was actually applied, per asset; asked of the gate itself.
        const scopeAssets = assets.length ? assets : ['BTC', 'ETH', 'SOL', 'XRP'];
        const gate = makeBookThrottle({ venue, assets: scopeAssets, from: days[0], to: days[days.length - 1] });
        report.coverage.book_throttle = throttleFlag === 'off'
          ? 'off'
          : Object.fromEntries(scopeAssets.map((a) => [a, gate.windowFor(a)]));
      }
      if (generic) {
        report = applyGenericExtras(report, genericReportExtras({
          trades: base.trades,
          markets,
          unusable: genericDecoded.unusable,
          counts: genericDecoded.counts,
        }));
      }

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
        record: rec,
        runId: report.run_id,
        report,
        trades: base.trades,
        fills: base.fills,
        logs: base.logs,
        markets: localMarkets,
        source: checked.files,
      });
      await writeFile(outFile, zip);
      if (!flags.json) process.stdout.write(`  archive        ${outFile} (${(zip.length / 1024).toFixed(0)} KB)\n\n`);
      return 0;
    } finally {
      await rm(jobDir, { recursive: true, force: true });
    }
  } finally {
    await rm(eventsDir, { recursive: true, force: true });
  }
}

export { LANGUAGES };
