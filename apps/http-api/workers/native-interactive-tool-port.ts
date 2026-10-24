import type { InteractiveToolPort, ToolReview } from '@mcp/code-agent/ports/interactive-tool-port.js';
import type { NativeCoderInteractions } from '../sse/native-coder-interactions.js';

/** Uses the existing durable facade response path. The tool input is already
 * committed before this Host capability starts; publication grants no effect. */
export class NativeInteractiveToolPort implements InteractiveToolPort {
  private approved = false;
  private approvedSpecPath?: string;
  private activeReview?: ToolReview;
  constructor(readonly agentId: string, private readonly initialSpecMode: boolean,
    private readonly slots: NativeCoderInteractions,
    private readonly emit: (event: string, data: unknown) => void,
    private readonly assertCurrent: () => void) {}

  get planApproved() { return this.approved; }
  get specMode() { return this.initialSpecMode && !this.specApproved; }
  get specApproved() { return this.approvedSpecPath !== undefined; }
  approveSpec(path: string) {
    this.assertCurrent();
    if (!/^\.mcp\/specs\/[a-z0-9_-]+\.md$/.test(path)) throw new Error('Invalid approved specification path');
    this.approvedSpecPath = path;
  }
  approvePlan() {
    this.assertCurrent();
    if (this.specMode) throw new Error('Plan approval cannot release the specification gate');
    this.approved = true;
  }
  /** Agent input may supersede a question, never a human permission or gate. */
  async interruptForAgent(): Promise<boolean> {
    this.assertCurrent();
    const review = this.activeReview;
    if (!review || review.kind !== 'question' && review.kind !== 'decision') return false;
    return this.slots.provideInput(review.payload.id, JSON.stringify({ interrupted: true, source: 'agent' }));
  }
  async request(review: ToolReview, signal?: AbortSignal): Promise<string> {
    this.assertCurrent();
    signal?.throwIfAborted();
    const response = this.slots.waitForInput(review.payload.id, true);
    this.activeReview = review;
    const abort = () => { void this.slots.provideInput(review.payload.id, JSON.stringify({ aborted: true })); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      this.emit(review.kind, review.payload);
      const value = await response;
      signal?.throwIfAborted();
      // A closed input slot carries only cancellation, never an approval.
      // Preserve the legacy tool's normal aborted result when no signal was supplied.
      if (value !== '{"aborted":true}') this.assertCurrent();
      return value;
    } catch (cause) { abort(); throw cause; }
    finally { if (this.activeReview === review) this.activeReview = undefined; signal?.removeEventListener('abort', abort); }
  }
}
