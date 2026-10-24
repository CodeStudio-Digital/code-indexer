/**
 * Context-isolated Electron bridges cannot carry symbol-keyed properties.
 * AsyncIterable uses Symbol.asyncIterator, so exposing one directly from a
 * preload silently loses the iterable contract in the renderer.
 *
 * Keep the preload-facing value to string-keyed functions, then restore the
 * symbol locally after it has crossed the contextBridge boundary.
 */
export interface SerializableAsyncIterator<T> {
  next(): Promise<IteratorResult<T>>;
  return(): Promise<IteratorResult<T>>;
}

/** Convert an AsyncIterable into a contextBridge-safe, string-keyed object. */
export function toSerializableAsyncIterator<T>(
  iterable: AsyncIterable<T>,
): SerializableAsyncIterator<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  return {
    next: () => iterator.next(),
    return: () => iterator.return?.() ?? Promise.resolve({ value: undefined as never, done: true }),
  };
}

/** Restore the AsyncIterable contract inside the renderer's own JS realm. */
export function fromSerializableAsyncIterator<T>(
  iterator: SerializableAsyncIterator<T>,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next: () => iterator.next(),
        return: () => iterator.return(),
      };
    },
  };
}
