/**
 * Backpressure-aware line writer for a child process's stdin.
 *
 * Both the queued worker and `ot run` push an entire archive down one pipe —
 * tens of millions of newline-framed rows for a large run. Ignoring what
 * `write()` returns does not merely buffer: past the pipe's high-water mark the
 * rows stop reaching the harness, and because a strategy that exits early
 * closes the pipe under us, the failure arrives as an error on a stream nobody
 * is listening to. The result is a run that replays the first fraction of its
 * markets, exits 0, and produces a report that looks complete.
 *
 * That is not hypothetical: `ot run` did exactly this. It wrote 6.04M rows in a
 * synchronous loop with `stdin.on('error', () => {})`, and a 289-market day
 * came back as a 2-market report with no warning at all.
 *
 * Two details here are paid for in incidents and must not be simplified away:
 *
 *   1. ONE error listener for the whole stream, not one per line. A `once`
 *      added per write and never removed is millions of live listeners, and the
 *      writer dies of its own bookkeeping partway through a run.
 *   2. An error has to settle a PENDING DRAIN. If the pipe breaks while we are
 *      parked waiting for one, the drain never arrives, the promise never
 *      settles, and the consumer waits for input that is not coming — burning
 *      the whole wall clock instead of failing in the second it broke.
 */

/**
 * @param {import('node:stream').Writable} stream
 * @returns {(line: string) => Promise<void>} resolves once the line is accepted
 */
export function createLineWriter(stream) {
  let writeError = null;
  let wakeDrain = null;

  stream.on('error', (err) => {
    writeError = err;
    const wake = wakeDrain;
    wakeDrain = null;
    if (wake) wake();
  });

  return (line) => new Promise((resolve, reject) => {
    if (writeError) { reject(writeError); return; }
    // Sequential by contract, and it says so rather than corrupting quietly.
    // `wakeDrain` is a single slot: a second concurrent call would overwrite
    // the first one's continuation, so that write would never settle and its
    // line could interleave into the middle of another. Both callers await
    // every line, and the framing (a market header, then that market's rows)
    // only means anything in order — so this is a programming error, not a
    // case to support.
    if (wakeDrain) {
      reject(new Error('createLineWriter: concurrent write; lines must be awaited one at a time'));
      return;
    }
    // Respect backpressure: ignoring the return of write() is the whole bug.
    if (stream.write(`${line}\n`)) { resolve(); return; }
    wakeDrain = () => {
      stream.removeListener('drain', onDrain);
      if (writeError) reject(writeError);
      else resolve();
    };
    function onDrain() {
      const wake = wakeDrain;
      wakeDrain = null;
      if (wake) wake();
    }
    stream.once('drain', onDrain);
  });
}
