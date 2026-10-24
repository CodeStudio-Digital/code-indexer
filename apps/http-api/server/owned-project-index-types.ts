export interface OwnedProjectIndexService {
  reconcile(projectId: number, input: Record<string, unknown>, control: {
    signal: AbortSignal; assertCurrent(): void;
  }): Promise<string>;
}
