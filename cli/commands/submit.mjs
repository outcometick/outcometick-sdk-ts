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
import { readKey, get, post, DEFAULT_API } from '../api-client.mjs';

export async function cmdSubmit({ dir, flags }) {
  const api = flags.api ?? DEFAULT_API;
  const key = readKey();

  const assets = (flags.assets ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  if (assets.length === 0) throw new Error('--assets is required, e.g. --assets btc,eth');
  if (!flags.from && !flags.range && !flags.days) {
    throw new Error('give a range: --days <n> (the most recent n archived days) or --from <day> --to <day>.'
      + ' Backtests cover only the most recent archived days — see `ot help`.');
  }
  let days = null;
  if (flags.days != null) {
    days = Number(flags.days);
    if (!/^\d+$/.test(String(flags.days)) || days < 1) {
      throw new Error(`--days must be a whole number of days, got ${JSON.stringify(flags.days)}`);
    }
  }

  const files = await readSubmission(dir);
  const scope = {
    venue: flags.venue ?? 'polymarket',
    assets,
    ...(days != null ? { days }
      : flags.range ? { range: flags.range } : { from: flags.from, to: flags.to }),
  };

  // Locally first. The rejection codes are identical either way, so a customer
  // who fixes what `ot check` said will not be told something different here.
  const checked = await validate(files);

  // THE DATE WINDOW, before anything is uploaded. Only the most recent archived
  // days can be backtested, and the window moves every day — so it is asked
  // for rather than written down here. Advisory only: the server refuses the
  // same thing, and a capacity endpoint that cannot be reached is not a reason
  // to stop a submission it would have accepted.
  if (scope.from || scope.days != null) {
    const cap = await get(api, `/v1/backtest/capacity?venue=${encodeURIComponent(scope.venue)}`)
      .catch(() => null);
    const first = cap?.status === 200 ? cap.json?.first_complete_day : null;
    const last = cap?.json?.last_day ?? '…';
    const held = cap?.json?.archive_days;
    const n = cap?.json?.backtest_window_days ?? held;
    const window = `  Backtests cover only the most recent ${n ?? ''} archived days`
      + ` (${scope.venue}: ${first}..${last}). The window moves forward as days are archived.\n`;
    if (first && scope.from && String(scope.from) < first) {
      process.stderr.write(`\n  E_SCOPE — outside the backtest window.\n${window}`
        + `  --from ${scope.from} is earlier. Use --from ${first} or later, or --days ${held ?? n} for all of it.\n\n`);
      return 1;
    }
    if (first && scope.days != null && Number.isInteger(held) && scope.days > held) {
      process.stderr.write(`\n  E_SCOPE — outside the backtest window.\n${window}`
        + `  --days ${scope.days} is more than that. Use --days ${held} or fewer.\n\n`);
      return 1;
    }
  }

  // Series go straight to R2, the same way the web editor sends them.
  //
  // Not an optimisation for the CLI's sake — it is what makes "a series never
  // passes through the API box" true rather than true-for-browsers. Inlining a
  // 4MB CSV cost 69MB resident there for one submission, and leaving one client
  // doing it would have kept the whole cost while claiming it was gone.
  const seriesNames = new Set((checked.manifest.series ?? []).map((x) => x.file));
  const uploads = {};
  for (const f of files.filter((x) => seriesNames.has(x.name))) {
    const bytes = Buffer.byteLength(f.content, 'utf8');
    const sign = await post(api, '/v1/backtest/upload', { bytes }, key);
    if (sign.status !== 200 || !sign.json?.url) {
      throw new Error(`could not stage ${f.name}: ${sign.json?.error ?? sign.text}`);
    }
    // Exactly the headers the server signed. `if-none-match: *` is among them
    // and makes the url write-once; omitting any of them is a 403.
    const put = await fetch(sign.json.url, {
      method: 'PUT', headers: sign.json.headers, body: f.content,
    });
    if (!put.ok) throw new Error(`could not upload ${f.name}: HTTP ${put.status}`);
    uploads[f.name] = sign.json.key;
  }

  const body = {
    ...scope,
    files: files.filter((x) => !seriesNames.has(x.name)),
    ...(Object.keys(uploads).length ? { uploads } : {}),
    ...(flags.email ? { email: flags.email } : {}),
  };
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
    // DO NOT PROMISE THE EMAIL WHEN NONE WAS ASKED FOR. `--email` is what
    // fills deliver_to, and without it the delivery poller correctly skips the
    // run — so the old unconditional "(or wait for the email)" told every CLI
    // submitter to wait for something that was never going to arrive. The flag
    // was implemented and undocumented, which is the same failure from the
    // other side: nobody could use the thing this line advertised.
    process.stdout.write(flags.email
      ? `  ot status ${json.run_id}   (or wait for the email)\n\n`
      : `  ot status ${json.run_id}\n`
        + '  (no --email, so nothing will be sent — note that id down)\n\n');
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
  if (status === 422 && json?.code === 'E_SCOPE') {
    // The range, not the code: `ot check` never sees a range, so this is not
    // the "passed locally" contradiction below. Most often it is the moving
    // date window — the server's message names it and says what to change.
    process.stderr.write(`\n  ${json.code} — the requested scope cannot be run.\n  ${json.detail}\n\n`);
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
