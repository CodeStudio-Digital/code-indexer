export type BoardKind = 'message' | 'decision' | 'question' | 'deliverable' | 'handoff' | 'blocker';

export interface BoardEntry {
  /** Opaque identity of the independent board-item file. */
  id: string;
  /** Monotonic order inside the owning session bundle. */
  seq: number;
  company_session_id: string;
  author_role: string;
  agent_run_id: string | null;
  kind: BoardKind;
  content: string;
  mentions: string[];
  created_at: string;
  /** Null = active; non-null = belongs to that archived snapshot. */
  archive_id: string | null;
}
