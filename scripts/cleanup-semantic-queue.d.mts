export const redundantAttemptSql: string;
type Counts = Array<{ status: string; jobs: number }>;
export function cleanupSemanticQueue(input: {
  dbPath: string; apply?: boolean; backupDir?: string;
}): Promise<{
  applied: boolean; candidates?: number; removed?: number; before: Counts;
  after?: Counts; backupPath?: string; integrity?: string;
}>;
