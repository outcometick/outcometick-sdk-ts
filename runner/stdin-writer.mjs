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
 * Lines are BATCHED into ~64 KB writes. One write() per line was one write
 * syscall per line on a real pipe: measured on the production worker, feeding
 * one BTC market-day (5.9M lines, 808 MB) cost the worker 35 s of CPU into
 * /dev/null and 73 s into a pipe, while the reader got ~320 bytes per read.
 * The harness pulls lines one at a time from its own read buffer either way,
 * and the pipe already holds 64 KB of future lines, so batching changes no
 * isolation property — only how many syscalls carry the same bytes.
 *
 * Batching means lines can sit in this writer until the next flush, so the
 * stream must be ended through `write.end()`, which flushes first. Ending the
 * stream directly would drop the tail — and the "replayed fewer markets than
 * it was fed" checks on both sides would refuse the run.
 */
export const WRITE_BATCH_CHARS = 64 * 1024;

/**
 * @param {import('node:stream').Writable} stream
 * @param {{ batchChars?: number }} [opts] flush threshold; 0 = one write per line
 * @returns {((line: string) => Promise<void>) & { end: () => Promise<void> }}
 *   resolves once the line is accepted (buffered, or written with backpressure)
 */
export function createLineWriter(stream, { batchChars = WRITE_BATCH_CHARS } = {}) {
  let writeError = null;
  let wakeDrain = null;
  let pending = '';
  let ended = false;

  stream.on('error', (err) => {
    writeError = err;
    const wake = wakeDrain;
    wakeDrain = null;
    if (wake) wake();
  });

  // Sequential by contract, and it says so rather than corrupting quietly.
  // `wakeDrain` is a single slot: a second concurrent call would overwrite
  // the first one's continuation, so that write would never settle and its
  // line could interleave into the middle of another. Both callers await
  // every line, and the framing (a market header, then that market's rows)
  // only means anything in order — so this is a programming error, not a
  // case to support.
  const concurrent = () => new Error('createLineWriter: concurrent write; lines must be awaited one at a time');

  const flush = () => new Promise((resolve, reject) => {
    if (writeError) { reject(writeError); return; }
    if (wakeDrain) { reject(concurrent()); return; }
    const chunk = pending;
    pending = '';
    // Respect backpressure: ignoring the return of write() is the whole bug.
    if (!chunk || stream.write(chunk)) { resolve(); return; }
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

  const write = (line) => {
    if (writeError) return Promise.reject(writeError);
    if (wakeDrain) return Promise.reject(concurrent());
    if (ended) return Promise.reject(new Error('createLineWriter: write after end'));
    pending += `${line}\n`;
    return pending.length < batchChars ? Promise.resolve() : flush();
  };
  /** Flush what is buffered, then end the stream. */
  write.end = async () => {
    if (ended) return;
    ended = true;
    await flush();
    stream.end();
  };
  return write;
}
