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

/**
 * Statically analyse a checked submission.
 *
 * @param checked  The result of checkSubmission — already validated, so the
 *                 language is known to be one the contract lists.
 */
export async function analyzeSource(checked) {
  const { languageId, deps } = checked.manifest;
  if (languageId === 'nodejs') {
    return analyzeJavaScriptSubmission(checked.files, { deps });
  }
  if (languageId === 'python') {
    return analyzePythonSubmission(checked.files, { deps });
  }
  // Fail closed. A language the contract accepts but no analyser covers is a
  // gap on our side, and running it unanalysed is not the safe reading of it.
  const err = new Error(`no analyser for ${languageId}`);
  err.status = 503;
  throw err;
}
