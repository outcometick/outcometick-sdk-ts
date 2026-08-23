// Node-side wrapper around the Python static analyser.
//
// The analysis itself has to run in Python — a Python AST is the only thing
// that can tell a call from a docstring, and reimplementing one in JavaScript
// would drift from the language it is meant to describe. This module only
// shuttles a job in and a verdict out, so both languages reject through the
// same BacktestRejection type and the same codes.
//
// The analyser runs as a SEPARATE PROCESS with no arguments and a JSON job on
// stdin. It never imports the submitted code — it parses it. Importing to
// inspect is how a validator becomes the first thing an attacker executes.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BacktestRejection } from '../../api/lib/backtest-contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'python_analyze.py');

/** Interpreter to parse with. The sandbox image pins 3.12. */
export const PYTHON = process.env.OT_PYTHON || 'python3';

/**
 * Analyse a Python submission.
 *
 * @param {{name:string, content:string}[]} files
 * @param {{deps?:string[], timeoutMs?:number}} opts
 * @returns {Promise<{imports:string[]}>}
 */
export function analyzePythonSubmission(files, { deps = [], timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // No inherited environment: the analyser needs nothing from it, and a
      // PYTHONPATH or PYTHONSTARTUP pointing somewhere unexpected is a way to
      // change what parses.
      env: { PATH: process.env.PATH ?? '', PYTHONDONTWRITEBYTECODE: '1', PYTHONHASHSEED: '0' },
    });

    let out = '';
    let err = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      // A parse that will not terminate is not a strategy we can validate, and
      // it must not hold a worker open.
      reject(new BacktestRejection('E_BUDGET', `static analysis did not finish within ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`could not run the python analyser (${PYTHON}): ${e.message}`));
    });

    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let verdict;
      try {
        verdict = JSON.parse(out);
      } catch {
        reject(new Error(`python analyser produced no verdict: ${err.trim() || out.trim() || 'no output'}`));
        return;
      }
      if (verdict.ok) {
        resolve({ imports: verdict.imports ?? [] });
        return;
      }
      const { code, detail, ...extra } = verdict;
      reject(new BacktestRejection(code, detail, extra));
    });

    child.stdin.end(JSON.stringify({ files, deps }));
  });
}
