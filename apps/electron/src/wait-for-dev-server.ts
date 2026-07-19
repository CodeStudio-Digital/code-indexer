export interface WaitForDevServerOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nonNegative(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! >= 0 ? value! : fallback;
}

/** Wait until the renderer endpoint is accepting HTTP requests.
 *
 * `concurrently` starts Vite and Electron as siblings, so process start order
 * is not a readiness guarantee. Any non-5xx HTTP response proves that a server
 * owns the configured endpoint; Vite can then finish the renderer navigation.
 */
export async function waitForDevServer(
  url: string,
  options: WaitForDevServerOptions = {},
): Promise<void> {
  const timeoutMs = nonNegative(options.timeoutMs, 120_000);
  const retryDelayMs = nonNegative(options.retryDelayMs, 250);
  const requestTimeoutMs = nonNegative(options.requestTimeoutMs, 1_500);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((delayMs: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const startedAt = Date.now();
  let lastError = 'no HTTP response';

  while (true) {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.status < 500) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = errorMessage(error);
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) break;
    await sleep(Math.min(retryDelayMs, timeoutMs - elapsedMs));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for the dashboard at ${url}. Last error: ${lastError}`,
  );
}
