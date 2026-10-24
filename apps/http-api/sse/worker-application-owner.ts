export interface WorkerApplicationOwner {
  sessionId: string | number;
  projectId: number | null;
  projectRoot?: string | null;
  signal: AbortSignal;
  assertOwner(): void;
}

export type WorkerApplicationOwnerResolver = (runId: unknown, closing?: boolean) =>
  WorkerApplicationOwner | Promise<WorkerApplicationOwner>;
