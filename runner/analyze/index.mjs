// Shared language dispatch for CLI and server submission checks.

import { analyzeJavaScriptSubmission } from './javascript.mjs';
import { analyzePythonSubmission } from './python.mjs';
import { BacktestRejection, parseReferenceFeed, HOOK_NAMES } from '../../api/lib/backtest-contract.mjs';

/**
 * Check known feed, series and Python param reads against the manifest.
 * Reference names use canonical lower-case spellings, as at runtime.
 */
export function assertFeedsDeclared(feeds, manifest) {
  const refs = new Set(manifest.reference ?? []);
  const series = new Set((manifest.series ?? []).map((x) => x.name));
  const params = manifest.params ?? {};
  for (const f of feeds ?? []) {
    const at = f.line ? `${f.file}:${f.line}` : f.file;
    // Missing Python params raise. JavaScript returns undefined, so defaults
    // such as ctx.p.x ?? d remain valid there.
    if (f.kind === 'param') {
      if (Object.hasOwn(params, f.name)) continue;
      const read = /^[A-Za-z_]\w*$/.test(f.name) ? `ctx.p.${f.name}` : `ctx.p[${JSON.stringify(f.name)}]`;
      throw new BacktestRejection('E_MANIFEST',
        `${at}: ${read} is not declared — add ${JSON.stringify(f.name)} to "params" in outcometick.json`
          + ' (a run only gets the params declared there)',
        { file: f.file, line: f.line ?? null });
    }
    const call = `ctx.${f.kind}(${JSON.stringify(f.name)})`;
    if (f.kind === 'ref' && !refs.has(f.name)) {
      const canonical = parseReferenceFeed(f.name)?.canonical ?? null;
      const detail = canonical && refs.has(canonical)
        ? `${at}: ${call} — reference names are lower case; write ${JSON.stringify(canonical)}`
        : `${at}: ${call} is not declared — add ${JSON.stringify(canonical ?? f.name)} to "reference" in outcometick.json`
          + ' (in the editor: tick it under outside data)';
      throw new BacktestRejection('E_MANIFEST', detail, { file: f.file, line: f.line ?? null });
    }
    if (f.kind === 'ext' && !series.has(f.name)) {
      throw new BacktestRejection('E_MANIFEST',
        `${at}: ${call} is not declared — add a series named ${JSON.stringify(f.name)} to "series" in outcometick.json`,
        { file: f.file, line: f.line ?? null });
    }
  }
}

/**
 * Statically analyse a checked submission.
 *
 * @param checked  The result of checkSubmission, already validated, so the
 *                 language is known to be one the contract lists.
 */
export async function analyzeSource(checked) {
  const { languageId, deps, entry, hooks } = checked.manifest;
  // Where the runner passes the context: the entry class's declared hooks,
  // under this language's method names.
  const hookMethods = (hooks ?? []).map((h) => HOOK_NAMES[languageId]?.[h]).filter(Boolean);
  if (languageId === 'nodejs') {
    const result = analyzeJavaScriptSubmission(checked.files, { deps, entry, hookMethods });
    assertFeedsDeclared(result.feeds, checked.manifest);
    return result;
  }
  if (languageId === 'python') {
    const result = await analyzePythonSubmission(checked.files, { deps, entry, hookMethods });
    assertFeedsDeclared(result.feeds, checked.manifest);
    return result;
  }
  // Reject contract languages without an analyser.
  const err = new Error(`no analyser for ${languageId}`);
  err.status = 503;
  throw err;
}
