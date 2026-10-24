/** Stop waiting without allowing an unobserved rejection from late completion. */
export async function awaitMcpConnection<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason ?? new Error('External MCP connection cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try { return await Promise.race([operation, stopped]); }
  finally { signal.removeEventListener('abort', cancel); }
}
