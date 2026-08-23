// `ot fetch <run_id>` — download a finished run's archive.
//
// Referenced by `ot status`, which is why it exists: the same rule as `ot
// status` itself — do not print a command that is not real.
//
// The archive URL is presigned for 15 minutes and is a bearer token for someone
// else's strategy results, so this asks the API for a fresh one each time
// rather than caching anything.

import { writeFile } from 'node:fs/promises';
import { readKey, getBinary, DEFAULT_API } from '../api-client.mjs';

export async function cmdFetch({ dir, flags }) {
  const runId = dir;
  if (!runId || runId === '.') throw new Error('usage: ot fetch <run_id> [--out <file>]');
  const key = readKey();
  const api = flags.api ?? DEFAULT_API;

  const { status, json, text, body } = await getBinary(
    api, `/v1/backtest/run/${encodeURIComponent(runId)}/archive`, key,
  );

  if (status === 404) {
    process.stderr.write(`\n  no run ${runId} under this key\n\n`);
    return 1;
  }
  if (status === 409) {
    // The run exists but has produced nothing yet — a different thing from a
    // missing run, and the status is the useful part.
    process.stderr.write(`\n  no archive yet — run is ${json?.status ?? 'not finished'}\n`
      + `  ot status ${runId}\n\n`);
    return 1;
  }
  if (status !== 200 || !body) {
    process.stderr.write(`\n  ${status}: ${json?.error ?? text.slice(0, 300)}\n\n`);
    return 1;
  }

  const out = flags.out ?? `${runId}.zip`;
  await writeFile(out, body);
  process.stdout.write(`\n  ${out} (${(body.length / 1024).toFixed(0)} KB)\n\n`);
  return 0;
}
