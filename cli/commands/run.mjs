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
import { buildReport, metrics, LATENCY_STEPS } from '../../runner/engine/report.mjs';
import { buildArchive } from '../../runner/archive.mjs';
import { loadLocalDay, localDays, looksLikeArchive } from '../local-data.mjs';
import { readSubmission, validate } from '../ot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, '..', '..', 'runner');

/** Run one pass of the local harness over the given markets. */
function runHarness({ languageId, jobDir, job, markets, outputKey }) {
  const cmd = languageId === 'python' ? (process.env.OT_PYTHON || 'python3') : process.execPath;
  const argv = languageId === 'python'
    ? [path.join(RUNNER, 'harness/python/harness.py'), jobDir]
    : [path.join(RUNNER, 'harness/node/harness.mjs'), jobDir];

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ['pipe', 'inherit', 'pipe', 'pipe'] });
    const lines = [];
    let tail = '';
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdio[3].on('data', (d) => {
      tail += d;
      const parts = tail.split('\n');
      tail = parts.pop();
      for (const line of parts) {
        if (!line) continue;
        const parsed = parseOutputLine(outputKey, line);
        if (parsed) lines.push(parsed);
      }
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr, lines }));

    child.stdin.on('error', () => {});
    child.stdin.write(`${JSON.stringify({ ...job, outputKey })}\n`);
    for (const m of markets) {
      child.stdin.write(`${JSON.stringify({ market: m.market, stream: m.stream, n: m.events.length })}\n`);
      for (const ev of m.events) child.stdin.write(`${JSON.stringify(ev)}\n`);
    }
    child.stdin.end();
  });
}

function demux(lines) {
  const trades = [];
  const fills = [];
  const logs = [];
  let result = parseResult({});
  for (const { channel, payload } of lines) {
    if (channel === CHANNEL.log) { logs.push(payload); continue; }
    if (channel === CHANNEL.result) {
      try { result = parseResult(JSON.parse(payload)); } catch { /* keep the empty one */ }
      continue;
    }
    let raw;
    try { raw = JSON.parse(payload); } catch { continue; }
    const row = channel === CHANNEL.trade ? parseTrade(raw) : parseFill(raw);
    if (!row) continue;
    (channel === CHANNEL.trade ? trades : fills).push(row);
  }
  return { trades, fills, logs: logs.join('\n'), result };
}

export async function cmdRun({ dir, flags }) {
  const dataRoot = flags.data;
  if (!dataRoot) {
    throw new Error('--data is required: point it at a cloned sample archive\n'
      + '  git clone https://github.com/Ligengxin96/polymarket-data-samples');
  }
  if (!await looksLikeArchive(dataRoot)) {
    throw new Error(`${path.resolve(dataRoot)} does not look like an archive — no recognisable data files under it`);
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

  const venue = flags.venue ?? 'polymarket';
  const assets = (flags.assets ?? '').split(',').map((a) => a.trim().toUpperCase()).filter(Boolean);

  const markets = [];
  for (const day of days) {
    const loaded = await loadLocalDay({
      root: dataRoot, day, venue,
      assets: assets.length ? assets : ['BTC', 'ETH', 'SOL', 'XRP'],
      datasets: manifest.datasets,
    });
    if (loaded.markets.length === 0) {
      process.stderr.write(`  ${day}: ${loaded.reason}\n`);
      continue;
    }
    markets.push(...loaded.markets);
  }
  if (markets.length === 0) throw new Error('no market-days could be read from that archive');

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
      process.stdout.write(`\n  ${markets.length} market-days · ${manifest.language} · local replay\n`);
    }

    const passes = [];
    for (const step of LATENCY_STEPS) {
      const outputKey = randomBytes(32).toString('hex');
      const res = await runHarness({
        languageId, jobDir, outputKey, markets,
        job: { ...baseJob, fillDelayMs: step.ms },
      });
      const out = demux(res.lines);
      if (step.ms === 0) {
        if (res.code === EXIT.rejected || res.code === EXIT.budget) {
          const r = out.result.rejection ?? { code: 'E_RUNTIME', detail: res.stderr.slice(0, 2000) };
          const err = new Error(r.detail);
          err.code = r.code;
          err.detail = r.detail;
          throw err;
        }
        if (res.code !== EXIT.ok) throw new Error(res.stderr.slice(0, 2000) || `harness exited ${res.code}`);
      }
      passes.push({ delayMs: step.ms, ...out, ok: res.code === EXIT.ok });
      // A strategy that never traded has no latency curve to draw.
      if (step.ms === 0 && out.trades.length === 0) break;
    }

    const base = passes[0];
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
      scope: {
        venue,
        assets: assets.length ? assets : [...new Set(markets.map((m) => m.market.asset).filter(Boolean))],
        from: days[0],
        to: days[days.length - 1],
        marketDays: markets.length,
        archivedDayCount: days.length,
      },
      scanned: { markets: base.result.marketsRun, market_days: markets.length, events: base.result.eventsSeen },
      trades: base.trades,
      fills: base.fills,
      marketSummaries: [...marketMeta.values()],
      marketMeta,
      feesPaid: base.result.feesPaid,
      latency: passes.filter((p) => p.ok).map((p) => ({
        delayMs: p.delayMs, netPnl: metrics(p.trades).net_pnl ?? 0,
      })),
      sweep: null,
      crosschecks: base.result.crosschecks,
      seed: Number(flags.seed ?? 1),
      coverage: {
        local: true,
        source: path.resolve(dataRoot),
        market_days_scanned: markets.length,
        streams: [...marketMeta.values()].reduce((acc, m) => {
          const k = m.stream ?? 'unknown';
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {}),
      },
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
