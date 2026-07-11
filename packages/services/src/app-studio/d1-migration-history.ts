interface WranglerD1QueryResult {
  results?: Array<{ name?: unknown }>;
}

export function parseLocalMigrationHistory(stdout: string): string[] | null {
  try {
    const jsonStart = stdout.indexOf('[');
    if (jsonStart < 0) return null;
    const batches = JSON.parse(stdout.slice(jsonStart)) as WranglerD1QueryResult[];
    if (!Array.isArray(batches)) return null;
    return batches.flatMap((batch) => Array.isArray(batch.results)
      ? batch.results.flatMap((row) => typeof row.name === 'string' ? [row.name] : [])
      : []);
  } catch {
    return null;
  }
}
