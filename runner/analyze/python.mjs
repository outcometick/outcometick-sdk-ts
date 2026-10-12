// Run the Python AST analyser in a separate process with a JSON job on stdin.
// Parse submitted code without importing it; convert verdicts to BacktestRejection.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BacktestRejection } from '../../api/lib/backtest-contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'python_analyze.py');

/** Interpreter to parse with. The sandbox image pins 3.14. */
export const PYTHON = process.env.OT_PYTHON || 'python3';

/**
 * Analyse a Python submission.
 *
 * @param {{name:string, content:string}[]} files
 * @param {{deps?:string[], timeoutMs?:number, entry?:{file:string,className:string}, hookMethods?:string[]}} opts
 *   `entry` and `hookMethods` say where the runner passes the context; without
 *   them no ctx.ref/ctx.ext call is reported.
 * @returns {Promise<{imports:string[], feeds:{kind:string,name:string,file:string,line:number}[]}>}
 */
export function analyzePythonSubmission(files, { deps = [], timeoutMs = 10_000, entry = null, hookMethods = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Exclude inherited Python settings that could change the parser environment.
      env: { PATH: process.env.PATH ?? '', PYTHONDONTWRITEBYTECODE: '1', PYTHONHASHSEED: '0' },
    });

    let out = '';
    let err = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      // Stop analysis that exceeds the validation deadline.
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
        resolve({ imports: verdict.imports ?? [], feeds: verdict.feeds ?? [] });
        return;
      }
      const { code, detail, ...extra } = verdict;
      reject(new BacktestRejection(code, detail, extra));
    });

    child.stdin.end(JSON.stringify({ files, deps, entry, hookMethods }));
  });
}
