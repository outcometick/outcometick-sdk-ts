/**
 * Backpressure-aware line writer for child stdin, shared by the worker and ot run.
 * Use one persistent error listener to avoid accumulating per-line listeners.
 * An error also wakes a pending drain wait, which otherwise might never settle.
 */

/**
 * Batch lines into roughly 64 KB writes to reduce pipe syscalls.
 * On the hosted worker, feeding 5.9M BTC lines (808 MB) one line at a time
 * cost 35 CPU seconds into /dev/null and 73 into a pipe.
 * The harness still consumes individual lines. End through write.end()
 * to flush the buffered tail before closing the stream.
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

  // Await writes sequentially. wakeDrain has one slot, so concurrent calls
  // could overwrite a continuation and break line ordering.
  const concurrent = () => new Error('createLineWriter: concurrent write; lines must be awaited one at a time');

  const flush = () => new Promise((resolve, reject) => {
    if (writeError) { reject(writeError); return; }
    if (wakeDrain) { reject(concurrent()); return; }
    const chunk = pending;
    pending = '';
    // Wait for drain when write() signals backpressure.
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
