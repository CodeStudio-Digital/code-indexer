import { createEventHandlers } from './handlers.js';
import type { SessionId, StreamBlock, UpdateSession } from './types.js';

export interface TurnProjectorScheduler {
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(handle: number): void;
  setFallback(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearFallback(handle: ReturnType<typeof setTimeout>): void;
}

export interface TurnProjectorOptions {
  sessionId: SessionId;
  initialBlocks?: StreamBlock[];
  updateSession: UpdateSession;
  onMessageComplete?: () => void;
  scheduler?: TurnProjectorScheduler;
}

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

  constructor(options: TurnProjectorOptions) {
    this.sessionId = options.sessionId;
    this.updateSession = options.updateSession;
    this.scheduler = options.scheduler ?? browserScheduler;
    this.blocks = options.initialBlocks ? [...options.initialBlocks] : [];

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
    });
    this.publishNow();
  }

  dispatch(event: string, data: Record<string, unknown>): boolean {
    if (this.disposed) return false;
    const handler = this.handlers[event];
    if (!handler) return false;
    handler(data, event);
    return true;
  }

  dispose(publishPending = false): void {
    if (this.disposed) return;
    if (publishPending) this.publishNow();
    this.disposed = true;
    this.cancelScheduledPublish();
  }

  private readonly commit = (): void => {
    if (this.disposed) return;
    this.updateSession(this.sessionId, { currentTurn: { blocks: [...this.blocks] } });
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
