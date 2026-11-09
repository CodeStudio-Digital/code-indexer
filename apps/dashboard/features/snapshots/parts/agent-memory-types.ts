export interface CuratedMemory {
  id: number; name: string; description: string; type: string; scope: string;
  source: string; importance: number; access_count: number; archived_at: string | null;
  archived_reason: string | null; source_snapshot_id: number | null; excerpt: string;
}
export interface MemoryPage {
  items: CuratedMemory[]; total: number; offset: number; limit: number; nextOffset: number | null;
  totals: { total: number; archived: number };
}
export const MEMORY_TYPES = ['note', 'architecture', 'decision', 'pattern', 'convention', 'gotcha', 'procedure', 'preference', 'external_pointer'] as const;
