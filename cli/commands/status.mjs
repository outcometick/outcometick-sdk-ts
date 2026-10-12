// Read a submitted run status. Fetch archives by run id through the API;
// presigned archive URLs expire after 15 minutes.

import { readKey, get } from '../api-client.mjs';

// Keep in sync with server statuses in api/lib/backtest-db.mjs.
export const STATUS_LINE = {
  staging: 'staging — the submission is still being stored',
  queued: 'queued — waiting for a worker',
  leased: 'leased — a worker has picked it up',
  running: 'running',
  complete: 'complete',
  failed: 'failed',
  rejected: 'rejected',
  cancelled: 'cancelled',
};

// Terminal states have settled ledger entries; other states still hold funds.
export const SETTLED = new Set(['complete', 'failed', 'rejected', 'cancelled']);

function ms(v) {
  return v == null ? '—' : new Date(v).toISOString().replace('T', ' ').slice(0, 19);
}

export async function cmdStatus({ dir, flags }) {
  // The run id is positional, which `parseArgs` hands back as `dir`.
  const runId = dir;
  if (!runId || runId === '.') throw new Error('usage: ot status <run_id>');
  const key = readKey();
  const api = flags.api ?? 'https://outcometick.com';

  const { status, json, text } = await get(api, `/v1/backtest/run/${encodeURIComponent(runId)}`, key);
  if (status === 404) {
    process.stderr.write(`\n  no run ${runId} under this key\n\n`);
    return 1;
  }
  if (status === 401) {
    process.stderr.write('\n  OT_BACKTEST_KEY was not accepted.\n\n');
    return 1;
  }
  if (status !== 200 || !json) {
    process.stderr.write(`\n  ${status}: ${json?.error ?? text.slice(0, 300)}\n\n`);
    return 1;
  }

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(json)}\n`);
    return 0;
  }

  process.stdout.write(`\n  ${json.run_id}\n`);
  process.stdout.write(`  status      ${STATUS_LINE[json.status] ?? json.status}\n`);
  process.stdout.write(`  scope       ${json.venue} · ${(json.assets ?? []).join(' ')} · ${json.from}..${json.to}\n`);
  process.stdout.write(`  market-days ${json.market_days}\n`);
  process.stdout.write(`  submitted   ${ms(json.created_ms)}\n`);
  if (json.finished_ms) process.stdout.write(`  finished    ${ms(json.finished_ms)}\n`);

  if (json.rejection) {
    process.stdout.write(`\n  ${json.rejection.code}\n  ${json.rejection.detail}\n`);
  }

  // Show spent and returned amounts only after settlement. A terminal run
  // without credits_spent spent zero; nonterminal runs still hold the amount.
  const spent = json.credits_spent ?? (SETTLED.has(json.status) && json.status !== 'complete' ? 0 : null);
  if (SETTLED.has(json.status) && spent != null) {
    const held = json.credits_held ?? 0;
    const returned = held - spent;
    process.stdout.write(`  credits     ${spent} spent`);
    process.stdout.write(returned > 0 ? ` (${returned} returned)\n` : '\n');
  } else if (json.credits_held != null) {
    process.stdout.write(`  credits     ${json.credits_held} held\n`);
  }

  const m = json.report?.metrics;
  if (m) {
    const money = (v) => (v == null ? '—' : `${v < 0 ? '-' : '+'}$${Math.abs(v).toLocaleString()}`);
    process.stdout.write(`\n  net pnl     ${money(m.net_pnl)}\n`);
    process.stdout.write(`  trades      ${m.trades}\n`);
    if (m.win_rate != null) process.stdout.write(`  win rate    ${(m.win_rate * 100).toFixed(1)}%\n`);
  }

  if (json.archive_available) {
    const kb = json.archive_bytes == null ? '' : ` (${(json.archive_bytes / 1024).toFixed(0)} KB)`;
    process.stdout.write(`\n  archive${kb}\n`);
    process.stdout.write(`  ot fetch ${json.run_id}\n`);
  }
  process.stdout.write('\n');
  return 0;
}
