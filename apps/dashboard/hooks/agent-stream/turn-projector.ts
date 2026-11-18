import { createEventHandlers } from './handlers.js';
import type { SessionId, StreamBlock, UpdateSession } from './types.js';

export interface TurnProjectorScheduler {
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(handle: number): void;
  setFallback(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearFallback(handle: ReturnType<typeof setTimeout>): void;
}

interface TurnProjectorOptions {
  sessionId: SessionId;
  initialBlocks?: StreamBlock[];
  updateSession: UpdateSession;
  onMessageComplete?: () => void;
  scheduler?: TurnProjectorScheduler;
  /**
   * The stream picks up in the middle of an assistant run, so the buffer this
   * projector rebuilds is a SUFFIX of what history already holds. Reconciliation
   * has to match it anywhere in the persisted run instead of from offset zero.
   */
  startsMidTurn?: boolean;
}

/**
 * Events that only extend existing content. They move text/thinking forward but
 * never change which blocks exist or what identity they carry, so they must not
 * bump the structural revision — that would defeat the per-frame memo the
 * transcript projection relies on.
 */
const NON_STRUCTURAL_EVENTS = new Set([
  'text',
  'thinking',
  'task_run_task_progress',
  'agent_progress',
  'chat_session_created',
  'operation_started',
  'operation_finished',
]);

const browserScheduler: TurnProjectorScheduler = {
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
  setFallback: (callback, delayMs) => setTimeout(callback, delayMs),
  clearFallback: (handle) => clearTimeout(handle),
};

export class TurnProjector {
  readonly blocks: StreamBlock[];

  private readonly sessionId: SessionId;
  private readonly updateSession: UpdateSession;
  private readonly scheduler: TurnProjectorScheduler;
  private readonly handlers: ReturnType<typeof createEventHandlers>;
  private frameHandle: number | null = null;
  private fallbackHandle: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private startsMidTurn: boolean;
  private structuralRev = 0;

  constructor(options: TurnProjectorOptions) {
    this.sessionId = options.sessionId;
    this.updateSession = options.updateSession;
    this.scheduler = options.scheduler ?? browserScheduler;
    this.blocks = options.initialBlocks ? [...options.initialBlocks] : [];
    this.startsMidTurn = options.startsMidTurn === true;

    const toolIndex = new Map<string, number>();
    for (let index = 0; index < this.blocks.length; index++) {
      const block = this.blocks[index];
      if (block.type === 'tool') toolIndex.set(block.call.id, index);
    }

    this.handlers = createEventHandlers({
      sid: this.sessionId,
      blocks: this.blocks,
      toolIndex,
      flush: this.schedulePublish,
      flushNow: this.publishNow,
      updateSession: this.updateSession,
      onMessageComplete: options.onMessageComplete,
      clearStartsMidTurn: this.clearStartsMidTurn,
    });
    // Publishing an empty buffer here would wipe the accumulated turn that a
    // cursorless reattach is about to rebuild from the replay, so the first
    // replayed event publishes instead.
    if (!this.startsMidTurn || this.blocks.length > 0) this.publishNow();
  }

  dispatch(event: string, data: Record<string, unknown>): boolean {
    if (this.disposed) return false;
    const handler = this.handlers[event];
    if (!handler) return false;
    if (!NON_STRUCTURAL_EVENTS.has(event)) this.structuralRev++;
    handler(data, event);
    return true;
  }

  /**
   * The buffer is aligned with a real turn boundary again — later comparisons
   * can go back to matching the persisted run from its start.
   */
  private readonly clearStartsMidTurn = (): void => {
    this.startsMidTurn = false;
  };

  dispose(publishPending = false): void {
    if (this.disposed) return;
    if (publishPending) this.publishNow();
    this.disposed = true;
    this.cancelScheduledPublish();
  }

  private readonly commit = (): void => {
    if (this.disposed) return;
    this.updateSession(this.sessionId, {
      currentTurn: {
        blocks: [...this.blocks],
        rev: this.structuralRev,
        ...(this.startsMidTurn ? { startsMidTurn: true } : {}),
      },
    });
  };

  private readonly cancelScheduledPublish = (): void => {
    if (this.frameHandle !== null) {
      this.scheduler.cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }
    if (this.fallbackHandle !== null) {
      this.scheduler.clearFallback(this.fallbackHandle);
      this.fallbackHandle = null;
    }
  };

  private readonly publishNow = (): void => {
    this.cancelScheduledPublish();
    this.commit();
  };

  private readonly schedulePublish = (): void => {
    if (this.disposed || this.frameHandle !== null) return;
    this.frameHandle = this.scheduler.requestFrame(() => {
      this.frameHandle = null;
      if (this.fallbackHandle !== null) {
        this.scheduler.clearFallback(this.fallbackHandle);
        this.fallbackHandle = null;
      }
      this.commit();
    });
    this.fallbackHandle = this.scheduler.setFallback(() => {
      this.fallbackHandle = null;
      if (this.frameHandle === null) return;
      this.scheduler.cancelFrame(this.frameHandle);
      this.frameHandle = null;
      this.commit();
    }, 50);
  };
}
