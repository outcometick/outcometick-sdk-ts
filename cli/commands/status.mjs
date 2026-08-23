// `ot status <run_id>` — where a submitted run got to.
//
// This command exists because `ot submit` prints it. A tool that tells you to
// run something that does not exist is worse than one that tells you nothing.
//
// It reads; it never bills, cancels or retries. The archive it points at is
// fetched through the API rather than a stored URL: archive links are 15-minute
// bearer tokens for someone's strategy results, so the right thing to hold onto
// is the run id, not the link.

import { readKey, get } from '../api-client.mjs';

const STATUS_LINE = {
  staging: 'staging — the submission is still being stored',
  queued: 'queued — waiting for a worker',
  running: 'running',
  done: 'done',
  failed: 'failed',
  rejected: 'rejected',
  expired: 'expired — the archive is past its retention window',
};

// Statuses in which the ledger has settled, so spent-vs-returned is a fact
// rather than a guess. Anything not listed still holds the credits.
const SETTLED = new Set(['done', 'failed', 'rejected', 'expired']);

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

  // Held vs spent, said plainly: a partial run bills for the market-days it
  // actually read, and the difference goes back. Printing only one of the two
  // numbers is how a refund looks like an overcharge.
  //
  // But "returned" may only be said once the run has actually finished. While
  // it is still staging or queued nothing has been spent and nothing has been
  // returned either — the credits are HELD. Deriving the refund from
  // held - spent in that state prints "0 spent (100 returned)" at a moment when
  // the customer's balance is still 100 short, which is the opposite of
  // reassuring.
  if (SETTLED.has(json.status) && json.credits_spent != null) {
    const held = json.credits_held ?? 0;
    const returned = held - json.credits_spent;
    process.stdout.write(`  credits     ${json.credits_spent} spent`);
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
