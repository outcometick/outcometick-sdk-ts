// Download a finished run archive. Request a fresh URL for each download;
// the presigned bearer URL expires after 15 minutes.

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
    // An existing run may not have an archive yet. Show its status.
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
