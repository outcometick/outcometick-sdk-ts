// `ot submit` — send a validated submission to the queue.
//
// Validates locally FIRST, with the same validator the queue runs, so the
// common failures cost a round trip rather than a queued run. The server
// validates again regardless: a client that decided its own submission was fine
// is not a security model, and the CLI is a convenience, not an authority.
//
// The same goes for the price. `ot submit` prints what the server quoted; it
// never computes one. A number this file derived would be a second pricing
// implementation, and the first time it disagreed the customer would be told
// one thing and charged another.

import { readSubmission, validate } from '../ot.mjs';
import { readKey, post, DEFAULT_API } from '../api-client.mjs';

export async function cmdSubmit({ dir, flags }) {
  const api = flags.api ?? DEFAULT_API;
  const key = readKey();

  const assets = (flags.assets ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  if (assets.length === 0) throw new Error('--assets is required, e.g. --assets btc,eth');
  if (!flags.from && !flags.range) throw new Error('--from and --to are required, or --range "30 days"');

  const files = await readSubmission(dir);
  const scope = {
    venue: flags.venue ?? 'polymarket',
    assets,
    ...(flags.range ? { range: flags.range } : { from: flags.from, to: flags.to }),
  };

  // Locally first. The rejection codes are identical either way, so a customer
  // who fixes what `ot check` said will not be told something different here.
  await validate(files);

  const body = { ...scope, files, ...(flags.email ? { email: flags.email } : {}) };
  const { status, json, text } = await post(api, '/v1/backtest/submit', body, key);

  if (status === 202 && json?.run_id) {
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(json)}\n`);
      return 0;
    }
    const q = json.quote ?? {};
    process.stdout.write(`\n  queued — ${json.run_id}\n`);
    process.stdout.write(`  scope       ${q.venue} · ${(q.assets ?? []).join(' ')} · ${q.from}..${q.to}\n`);
    process.stdout.write(`  market-days ${q.marketDays}\n`);
    if (q.missingDays > 0) {
      // Said out loud: a smaller number than the range asked for, unexplained,
      // reads as a bug in our favour.
      process.stdout.write(`  not in the archive: ${q.missingDays} day(s) — not billed\n`);
    }
    process.stdout.write(`  cost        ${json.credits_held} cr\n`);
    process.stdout.write(`  source      sha256 ${String(json.source_sha256).slice(0, 16)}…\n\n`);
    process.stdout.write(`  ot status ${json.run_id}   (or wait for the email)\n\n`);
    return 0;
  }

  if (status === 402) {
    process.stderr.write(`\n  not enough credits: have ${json?.balance}, this run needs ${json?.required}\n\n`);
    return 1;
  }
  if (status === 401) {
    process.stderr.write('\n  OT_BACKTEST_KEY was not accepted.\n\n');
    return 1;
  }
  if (status === 422 && json?.code) {
    // The server rejected something the local validator passed. That should not
    // happen — the promise is that they are the same validator — so say so
    // rather than printing it as an ordinary error.
    process.stderr.write(`\n  ${json.code}\n  ${json.detail}\n\n`
      + '  This passed `ot check` locally. That is a bug on our side —\n'
      + '  please report it with the manifest.\n\n');
    return 1;
  }
  process.stderr.write(`\n  ${status}: ${json?.error ?? text.slice(0, 300)}\n\n`);
  return 1;
}
