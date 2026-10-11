// The decoded-day cache of `ot run`: a day of the archive is decoded once (the
// slow half of a local replay) and kept, so the next run over the same day
// starts replaying at once. The Python package keeps the same kind of cache
// (client/backtest/local.py); this one holds the JavaScript decoder's output.
//
// An entry is exactly what loadLocalDay spools into its events directory, plus
// day.json with the rest of its answer, so a cached day replays the same bytes
// as a fresh decode. The key names everything that decides those bytes: the
// decoder's own source (every module it imports), the request (venue, day,
// assets, datasets, intervals), the cadence the day is thinned at, and every
// archive file of that day by sha256 -- a re-downloaded or corrected day is a
// different day.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dayOfPath, loadLocalDay, walk } from './local-data.mjs';

// 1: first version. 2: day.json holds { answer, files } with each events file's length and sha256.
const FORMAT = 2;
const DECODER = fileURLToPath(new URL('./local-data.mjs', import.meta.url));

/** Where `ot run` keeps decoded days unless told otherwise. */
export function defaultCacheRoot(env = process.env) {
  const base = env.XDG_CACHE_HOME || path.join(homedir(), '.cache');
  return path.join(base, 'outcometick', 'decoded-js');
}

const IMPORT = /^\s*(?:import|export)\b[^'"`]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/gm;

/** local-data.mjs and every module it reaches through relative imports. */
export async function decoderSources(entry = DECODER) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = await readFile(file, 'utf8');
    for (const m of src.matchAll(IMPORT)) queue.push(path.resolve(path.dirname(file), m[1]));
  }
  return [...seen].sort();
}

/**
 * sha256 over the decoder's source (decoderSources: spool-day, events, the
 * taxonomy, ...). Any change to any of them retires every entry.
 */
export async function decoderDigest(entry = DECODER) {
  const root = path.dirname(path.dirname(entry));
  const h = createHash('sha256');
  for (const file of await decoderSources(entry)) {
    h.update(`${path.relative(root, file)}\0`);
    h.update(await readFile(file));
    h.update('\0');
  }
  return h.digest('hex');
}

async function fileSha256(file) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

/** The cache key of one day (see the top of this file). */
export async function cacheKey({ root, day, venue, assets, datasets, intervals, throttle, decoder }) {
  const files = [];
  for (const rel of (await walk(root)).filter((r) => dayOfPath(r) === day).sort()) {
    files.push([rel, await fileSha256(path.join(root, rel))]);
  }
  const upper = [...new Set((assets ?? []).map((a) => String(a).toUpperCase()))].sort();
  const spec = {
    format: FORMAT,
    decoder,
    venue,
    day,
    assets: upper,
    datasets: [...(datasets ?? [])].sort(),
    intervals: [...(intervals ?? [])].map(String).sort(),
    // The windows the gate will use, asked of the gate itself (makeBookThrottle):
    // each asset in scope, and the fallback for a row of no known asset.
    throttle: throttle == null ? 'off' : {
      assets: Object.fromEntries(upper.map((a) => [a, throttle.windowFor(a)])),
      fallback: throttle.windowFor(''),
    },
    files,
  };
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 24);
}

/**
 * An entry's answer, `ABSENT`, or `DAMAGED`. day.json records every events
 * file's length and sha256; a file that is missing, shorter, longer or
 * different -- cleaned out from under us, a disk fault -- damages the whole
 * entry rather than replaying damaged events. An entry appears only by
 * rename() of a finished directory, so a good one never looks damaged.
 */
const ABSENT = Symbol('absent');
const DAMAGED = Symbol('damaged');

async function readEntry(dir) {
  let stored;
  try {
    stored = JSON.parse(await readFile(path.join(dir, 'day.json'), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      try {
        await readdir(dir);
        return DAMAGED;  // the directory without its day.json
      } catch (e) {
        if (e.code === 'ENOENT') return ABSENT;
        throw e;
      }
    }
    if (err instanceof SyntaxError || err.code === 'ENOTDIR') return DAMAGED;
    throw err;
  }
  const { answer, files } = stored ?? {};
  if (!answer || !Array.isArray(answer.markets) || !files || typeof files !== 'object') return DAMAGED;
  for (const m of answer.markets) {
    const want = files[m.eventsFile];
    if (!want) return DAMAGED;
    let bytes;
    try {
      bytes = await readFile(path.join(dir, m.eventsFile));
    } catch (err) {
      if (err.code === 'ENOENT') return DAMAGED;
      throw err;
    }
    if (bytes.length !== want.bytes || createHash('sha256').update(bytes).digest('hex') !== want.sha256) return DAMAGED;
    // Absolute, so the replay finds each market's events wherever its day lives.
    m.eventsFile = path.join(dir, m.eventsFile);
  }
  return answer;
}

const ATTEMPTS = 3;

/**
 * loadLocalDay, served from the cache under `cacheRoot` when it can be: the
 * same answer, with each market's `eventsFile` an absolute path. `newThrottle`
 * makes a fresh makeBookThrottle for this day (null: unthinned) -- fresh for
 * every decode, because a gate remembers the rows it has kept.
 *
 * The key is taken again after decoding: a file replaced in between (a
 * download finishing, a corrected day) would otherwise file one set of bytes'
 * events under another's key. Then the decode is thrown away and done again.
 *
 * A damaged entry is never touched -- deleting or replacing it could race with
 * another run doing the same -- and this run decodes the day into its own
 * `eventsDir` instead, as `--cache off` would, and says how to clear it.
 */
export async function loadLocalDayCached({ cacheRoot, decoder, newThrottle = null, ...kw }) {
  // Inside the archive, the cache's own files would count as the day's files:
  // every decode would change the key it is stored under. Real paths, so a
  // symlink cannot hide it.
  await mkdir(cacheRoot, { recursive: true });
  const inside = path.relative(await realpath(kw.root), await realpath(cacheRoot));
  if (inside === '' || !(inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside))) {
    throw new Error(`the decoded-day cache ${cacheRoot} is inside the archive ${kw.root}; `
      + 'pass --cache <a directory outside it>, or --cache off');
  }
  const gate = () => (newThrottle ? newThrottle() : null);
  for (let attempt = 1; ; attempt += 1) {
    const key = await cacheKey({ ...kw, throttle: gate(), decoder });
    const entry = path.join(cacheRoot, key);
    const hit = await readEntry(entry);
    if (hit === DAMAGED) {
      process.stderr.write(`  ${kw.day}: the decoded-day cache entry ${entry} is damaged; decoding without it. `
        + 'Delete that directory to have it stored again.\n');
      return loadLocalDay({ ...kw, throttle: gate() });
    }
    if (hit !== ABSENT) return hit;
    await mkdir(cacheRoot, { recursive: true });
    const work = await mkdtemp(path.join(cacheRoot, '.tmp-'));
    try {
      const loaded = await loadLocalDay({ ...kw, throttle: gate(), eventsDir: work });
      if (await cacheKey({ ...kw, throttle: gate(), decoder }) !== key) {
        if (attempt < ATTEMPTS) continue;
        throw new Error(`the archive's files for ${kw.day} kept changing while they were decoded; run again once they are complete`);
      }
      const files = {};
      for (const m of loaded.markets) {
        const bytes = await readFile(path.join(work, m.eventsFile));
        files[m.eventsFile] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      }
      await writeFile(path.join(work, 'day.json'), JSON.stringify({ answer: loaded, files }));
      try {
        await rename(work, entry);
      } catch (err) {
        // Another run stored the same day first; theirs is as good as ours.
        // Anything else (a read-only cache, say) is worth seeing.
        const theirs = await readEntry(entry);
        if (typeof theirs === 'symbol') throw err;
        return theirs;
      }
      const ours = await readEntry(entry);
      if (typeof ours === 'symbol') throw new Error(`the decoded-day cache entry ${entry} could not be read back`);
      return ours;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}
