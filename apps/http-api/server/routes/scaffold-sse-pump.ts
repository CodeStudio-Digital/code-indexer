/**
 * SSE operations used by the scaffold pump — narrow
 * enough that a test can supply a fake to assert the flush-before-close
 * discipline without standing up an HTTP server. The concrete SSE
 * `SSEStreamingApi` is structurally assignable to this.
 */
export interface ScaffoldSseStream {
  writeSSE(message: { data: string; event?: string; id?: string }): Promise<void>;
  close(): Promise<void>;
}

/**
 * Structural envelope the pump accepts — `ScaffoldStreamEvent` (projects)
 * and `DsStudioStreamEvent` (DS Studio, richer `done`) are both assignable.
 */
interface ScaffoldSseEvent {
  event: string;
  data: unknown;
}

/**
 * Pump scaffold events to an SSE stream, GUARANTEEING every frame (especially
 * the terminal `done`) is flushed before the stream closes.
 *
 * Writes are serialized through a FIFO promise chain and awaited in `finally`
 * before `close()`. A bare fire-and-forget `writeSSE` (the previous shape) let
 * `close()` race — and drop — the trailing burst (configure/register/done),
 * stranding the New Project wizard on its spinner for a scaffold that already
 * finished server-side. Each link still fires as the previous resolves, so
 * logs keep streaming live during long installs.
 */
export async function pumpScaffoldSSE(
  stream: ScaffoldSseStream,
  run: (emit: (ev: ScaffoldSseEvent) => void) => Promise<void>,
): Promise<void> {
  let seq = 0;
  let writeChain: Promise<void> = Promise.resolve();
  const emit = (ev: ScaffoldSseEvent) => {
    writeChain = writeChain
      .then(() => stream.writeSSE({ id: String(seq++), event: ev.event, data: JSON.stringify(ev.data) }))
      .catch(() => {}); // a write to a disconnected client must not break the chain
  };
  try {
    await run(emit);
  } catch (err) {
    emit({ event: 'error', data: { message: err instanceof Error ? err.message : String(err) } });
  } finally {
    await writeChain; // drain the tail (incl. `done`)…
    await stream.close(); // …then close
  }
}
