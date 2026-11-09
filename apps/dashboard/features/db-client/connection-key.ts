/** Runtime identity; persisted numeric ids are only unique within a project DB. */
export function connectionKey(projectId: number, id: number, database?: string): string {
  if (!Number.isSafeInteger(projectId) || projectId <= 0 || !Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid project/connection identity');
  return `p${projectId}/${id}${database ? `@${encodeURIComponent(database)}` : ''}`;
}

export function parseConnKey(key: string): { projectId?: number; id: number; database?: string } {
  const scoped = /^p([1-9]\d*)\/([1-9]\d*)(?:@(.*))?$/.exec(key);
  if (scoped) return { projectId: Number(scoped[1]), id: Number(scoped[2]), ...(scoped[3] !== undefined ? { database: decodeURIComponent(scoped[3]) } : {}) };
  // Existing tabs can be read while migrating; all new sessions use scoped keys.
  const legacy = /^([1-9]\d*)(?:@(.*))?$/.exec(key);
  if (legacy) return { id: Number(legacy[1]), ...(legacy[2] !== undefined ? { database: legacy[2] } : {}) };
  throw new Error('Invalid database connection key');
}
