import type { SessionReviewPort, SessionReviewCancellationReceipt } from '@mcp/code-agent/ports/session-review-port.js';

/** Invocation receipts are private Host state, never a model-supplied result. */
export class NativeSessionReviewPort implements SessionReviewPort {
  readonly runtimeGeneration = 'rust_v1' as const;
  private readonly receipts = new Map<string, string | undefined>();
  constructor(readonly sessionId: string, readonly agentRunId: string, readonly workspaceRoot: string,
    private readonly checkOwner: () => void) {}

  readonly assertOwner = (): void => { this.checkOwner(); };

  beginInvocation(invocationId: string): (receipt: SessionReviewCancellationReceipt) => void {
    this.assertOwner();
    if (!invocationId || invocationId.length > 512 || this.receipts.has(invocationId) || this.receipts.size >= 1024) {
      throw new Error('Native session review invocation is invalid, repeated or exceeds its receipt budget');
    }
    this.receipts.set(invocationId, undefined);
    return receipt => {
      this.assertOwner();
      if (!receipt.runId || receipt.runId.length > 256) throw new Error('Native session review receipt lacks its durable run');
      const previous = this.receipts.get(invocationId);
      if (previous && previous !== receipt.runId) {
        this.receipts.set(invocationId, undefined);
        throw new Error('Native session review receipt diverged');
      }
      this.receipts.set(invocationId, receipt.runId);
    };
  }

  isCancellationSettled(invocationId: string): boolean {
    try { this.assertOwner(); return typeof this.receipts.get(invocationId) === 'string'; }
    catch { return false; }
  }
}
