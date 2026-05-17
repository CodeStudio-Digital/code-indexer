import { EventEmitter } from 'node:events';
import type {
  Sandbox,
  SandboxEvent,
  SandboxLogLine,
  SandboxObserver,
  SandboxStep,
} from '../../types.js';

const MAX_LOG_LINES = 200;

/**
 * Event fan-out + log/step bookkeeping for sandboxes. Every status
 * transition flows through one of these methods so observers (the
 * dashboard's SSE bridge in `SandboxService`) see a coherent stream
 * AND each sandbox keeps a bounded ring buffer of recent log lines
 * for offline inspection via `GET /sandbox/:id/logs`.
 */
export class SandboxEventBus {
  private readonly emitter = new EventEmitter();

  subscribe(observer: SandboxObserver): () => void {
    const wrapped = (event: SandboxEvent) => observer(event);
    this.emitter.on('event', wrapped);
    return () => this.emitter.off('event', wrapped);
  }

  emit(event: SandboxEvent): void {
    this.emitter.emit('event', event);
  }

  /**
   * Update the sandbox's `step` + log the transition. The single writer
   * for `step`; emit is a separate `step` event so SSE subscribers
   * don't have to diff the full sandbox state.
   */
  recordStep(sb: Sandbox, step: SandboxStep, message: string): void {
    sb.step = step;
    this.appendLog(sb, 'info', message);
    this.emit({ kind: 'step', sandboxId: sb.id, step, message });
  }

  /**
   * Push a log line into the sandbox's ring buffer. Strips trailing
   * whitespace, truncates each line to 2 KiB, and caps the buffer at
   * `MAX_LOG_LINES` so a runaway `npm install` stderr can't bloat
   * memory.
   */
  appendLog(sb: Sandbox, level: SandboxLogLine['level'], text: string): void {
    const clean = text.replace(/\s+$/g, '').slice(0, 2_000);
    if (!clean) return;
    sb.recentLogs.push({ at: Date.now(), level, text: clean });
    if (sb.recentLogs.length > MAX_LOG_LINES) {
      sb.recentLogs.splice(0, sb.recentLogs.length - MAX_LOG_LINES);
    }
  }
}
