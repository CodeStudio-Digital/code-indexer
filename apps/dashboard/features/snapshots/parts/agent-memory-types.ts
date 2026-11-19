export interface CuratedMemory {
  id: number; name: string; description: string; type: string; scope: string;
  source: string; importance: number; access_count: number; archived_at: string | null;
  archived_reason: string | null; source_snapshot_id: number | null; excerpt: string;
  superseded_by_id?: number | null;
}
export interface MemoryPage {
  items: CuratedMemory[]; total: number; offset: number; limit: number; nextOffset: number | null;
  totals: { total: number; archived: number };
}
export const MEMORY_TYPES = ['note', 'architecture', 'decision', 'pattern', 'convention', 'gotcha', 'procedure', 'preference', 'external_pointer'] as const;

export function archiveReasonKey(reason: string): string {
  if (reason.startsWith('evolution:merge:') || reason === 'consolidated:duplicate') return 'merged';
  if (reason.startsWith('evolution:refine:')) return 'refined';
  if (reason.startsWith('evolution:superseded:')) return 'superseded';
  if (reason.startsWith('decayed:')) return 'inactive';
  if (reason.startsWith('forgotten:')) return 'manual';
  return 'archived';
}
