export interface SessionReviewCancellationReceipt { readonly runId: string }

/** Only the owning Host can confirm the review's terminal bookkeeping. */
export interface SessionReviewPort {
  readonly runtimeGeneration: 'rust_v1';
  readonly sessionId: string;
  readonly agentRunId: string;
  readonly workspaceRoot: string;
  /** Ownership only: terminal bookkeeping may settle after cancellation. */
  assertOwner(): void;
  beginInvocation(invocationId: string): (receipt: SessionReviewCancellationReceipt) => void;
  isCancellationSettled(invocationId: string): boolean;
}
