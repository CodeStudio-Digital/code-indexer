/**
 * Bounded-concurrency `map`, order-preserving.
 *
 * WHY: several hot paths reached for `Promise.all(items.map(...))` and then
 * queued thousands of async operations at once. That is not "parallel", it is
 * unbounded: a 5k-entry directory listing queued 5k `fs.stat` calls against
 * libuv's 4-thread pool and starved every other async fs operation in the
 * process until it drained; an SFTP transfer doing the same would open a
 * channel per file and hit OpenSSH's `MaxSessions` (10 by default).
 *
 * Results come back in input order regardless of completion order, so callers
 * can keep treating it as a drop-in for `Promise.all(map(...))`.
 * A rejection propagates like `Promise.all` — first error wins, in-flight work
 * is allowed to settle but no further items start.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const size = items.length;
  if (size === 0) return [];
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, size));
  const out = new Array<R>(size);
  let next = 0;
  let failed = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (failed) return;
      const i = next++;
      if (i >= size) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        failed = true; // stop handing out new work; siblings finish what they hold
        throw err;
      }
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  return out;
}
