// `ot fingerprint`: a run's pre-registration fingerprint, without running it.
//
// Publish the value before you look at any result; the report of the run you
// then make (`ot run`, `ot submit`, or outcometick.backtest) carries the same
// sha256 when the code, manifest, params, options, scope and seed are the same.
// See api/lib/backtest-fingerprint.mjs for exactly what it covers.

import { fingerprintOfFiles, expandDays, datasetDigest } from '../../api/lib/backtest-fingerprint.mjs';
import { looksLikeGenericDataset, datasetFiles, marketsFileOf } from '../../runner/generic-data.mjs';
import { readSubmission, validate } from '../ot.mjs';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function cmdFingerprint({ dir, flags }) {
  const files = await readSubmission(dir);
  await validate(files);
  const generic = flags.data != null && await looksLikeGenericDataset(flags.data);
  let scope;
  if (generic) {
    scope = { venue: 'polymarket', assets: [], days: [] };
  } else {
    const assets = String(flags.assets ?? '').split(',').map((a) => a.trim().toUpperCase()).filter(Boolean);
    if (!assets.length) throw new Error('--assets is required, e.g. --assets btc,eth (the fingerprint covers the scope)');
    if (!DAY.test(flags.from ?? '') || !DAY.test(flags.to ?? '')) {
      throw new Error('--from <YYYY-MM-DD> --to <YYYY-MM-DD> are required: the fingerprint covers the days you will run');
    }
    scope = { venue: flags.venue ?? 'polymarket', assets, days: expandDays(flags.from, flags.to) };
  }
  const throttle = flags['book-throttle'];
  if (throttle != null && throttle !== 'on' && throttle !== 'off') throw new Error(`--book-throttle must be on or off, got ${throttle}`);
  const markAge = flags['mark-max-age-ms'];
  if (markAge != null && !/^\d+$/.test(markAge)) throw new Error(`--mark-max-age-ms must be a whole number of milliseconds, got ${markAge}`);
  const fp = fingerprintOfFiles(files, {
    scope,
    seed: Number(flags.seed ?? 1),
    data: generic ? 'generic' : 'archive',
    dataSha256: generic
      ? await datasetDigest(flags.data, { marketsFile: await marketsFileOf(flags.data), files: await datasetFiles(flags.data) })
      : null,
    replay: { bookThrottle: throttle !== 'off', markMaxAgeMs: markAge == null ? null : Number(markAge) },
    feeBpsOverride: (() => { const v = Number(flags['fee-bps']); return flags['fee-bps'] != null && flags['fee-bps'] !== '' && Number.isFinite(v) && v >= 0 ? v : null; })(),
  });
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, fingerprint: fp, scope })}\n`);
    return 0;
  }
  process.stdout.write(`\n  fingerprint  ${fp.sha256}\n  code         ${fp.code_sha256 ?? '—'}\n`);
  process.stdout.write(`  scope        ${generic ? `your own data (${fp.data_sha256})` : `${scope.venue} · ${scope.assets.join(',')} · ${flags.from}..${flags.to}`}\n`);
  process.stdout.write('  The report of a run with this code, manifest, params and scope carries the same value.\n\n');
  return 0;
}
