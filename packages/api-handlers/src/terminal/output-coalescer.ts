/**
 * PTY output coalescing + replay-buffer bounds.
 *
 * A booting dev-server (vite/next) dumps a firehose of stdout: node-pty
 * emits dozens of tiny `data` chunks, and the manager fans EACH one out as
 * a separate MessagePort message → a separate `term.write` in the renderer.
 * That per-chunk overhead is what makes the UI engasgar "até subir".
 *
 * `OutputCoalescer` accumulates consecutive `data` strings over a short
 * window and emits ONE concatenated chunk per frame, collapsing N IPC
 * messages into ~1. `trimReplayBuffer` keeps the per-terminal replay buffer
 * bounded so re-attaching to a long-lived runner doesn't replay megabytes.
 *
 * Both behaviours are tunable via env (operator override only):
 *   MCP_PTY_COALESCE_MS      window in ms (0 = emit every chunk immediately)
 *   MCP_PTY_REPLAY_MAX_BYTES cap on buffered data bytes (0 = unbounded)
 */
import type { TerminalOutputChunk } from '@mcp/api-bus';

const DEFAULT_COALESCE_MS = 16;
const DEFAULT_REPLAY_MAX_BYTES = 256 * 1024;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const coalesceWindowMs = (): number => envInt('MCP_PTY_COALESCE_MS', DEFAULT_COALESCE_MS);
export const replayMaxBytes = (): number => envInt('MCP_PTY_REPLAY_MAX_BYTES', DEFAULT_REPLAY_MAX_BYTES);

export class OutputCoalescer {
  private pending = '';
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly emit: (chunk: TerminalOutputChunk) => void,
    private readonly windowMs: number = coalesceWindowMs(),
  ) {}

  /** Queue a data string; flushes after the window (or immediately when disabled). */
  push(data: string): void {
    if (this.windowMs <= 0) {
      this.emit({ type: 'data', data });
      return;
    }
    this.pending += data;
    // NOT unref'd: a 16ms timer must outlive a quiet tail so the last burst
    // of output reaches the renderer even if nothing else fires.
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.windowMs);
  }

  /** Emit any buffered data now — call before an `exit` chunk so order holds. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    const data = this.pending;
    this.pending = '';
    this.emit({ type: 'data', data });
  }
}

/**
 * Drop oldest `data` chunks from the front until the buffered byte total is
 * within `maxBytes`. `bytes` is the running total the caller maintains; the
 * trimmed total is returned. Never empties the buffer past the last chunk so
 * a fresh attach always sees the latest screenful. No-op when maxBytes <= 0.
 */
export function trimReplayBuffer(
  buffer: TerminalOutputChunk[],
  bytes: number,
  maxBytes: number = replayMaxBytes(),
): number {
  if (maxBytes <= 0) return bytes;
  while (bytes > maxBytes && buffer.length > 1) {
    const dropped = buffer.shift();
    if (dropped?.type === 'data') bytes -= dropped.data.length;
  }
  return bytes;
}
