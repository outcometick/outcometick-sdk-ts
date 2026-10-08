// Choosing the analyser for a submission's language.
//
// This exists as a shared function, in a file both sides can import, because
// the docs make a promise that only holds if there is ONE of it:
//
//     ot check runs the exact validator the queue runs. If it passes locally
//     it will not be rejected on submit.
//
// api/lib/backtest-routes.mjs and cli/ot.mjs both call this. They used to each
// dispatch on languageId themselves, and the two dispatches were not the same:
// the server threw for an unrecognised language while the CLI fell through to
// the JavaScript analyser. With only nodejs and python that difference was
// invisible, but it would have surfaced the day a third language was added —
// as `ot check` cheerfully passing a Go strategy it had analysed as JavaScript,
// followed by a rejection after queueing. Which is precisely the experience the
// promise above exists to prevent.

import { analyzeJavaScriptSubmission } from './javascript.mjs';
import { analyzePythonSubmission } from './python.mjs';
import { BacktestRejection, parseReferenceFeed, HOOK_NAMES } from '../../api/lib/backtest-contract.mjs';

/**
 * Every `ctx.ref(name)` / `ctx.ext(name)` the analyser could read must name a
 * feed or series the manifest declares.
 *
 * At run time an undeclared name is E_MANIFEST on the first market that asks —
 * after the run was queued and the credits held. On 2026-10-08 a customer hit
 * that three times in two minutes with the same source (a reference feed used
 * but not ticked in the editor), then gave the strategy up. Here it costs
 * nothing. The runtime lookup is exact, so this is too: the declared reference
 * names are the canonical (lower-case) spellings.
 */
export function assertFeedsDeclared(feeds, manifest) {
  const refs = new Set(manifest.reference ?? []);
  const series = new Set((manifest.series ?? []).map((x) => x.name));
  for (const f of feeds ?? []) {
    const at = f.line ? `${f.file}:${f.line}` : f.file;
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
 * @param checked  The result of checkSubmission — already validated, so the
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
  // Fail closed. A language the contract accepts but no analyser covers is a
  // gap on our side, and running it unanalysed is not the safe reading of it.
  const err = new Error(`no analyser for ${languageId}`);
  err.status = 503;
  throw err;
}
