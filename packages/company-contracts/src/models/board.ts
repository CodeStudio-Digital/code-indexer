export type BoardKind = 'message' | 'decision' | 'question' | 'deliverable' | 'handoff';

export interface BoardEntry {
  id: number;
  company_session_id: number;
  author_role: string;
  agent_run_id: number | null;
  kind: BoardKind;
  content: string;
  mentions: string[];
  created_at: string;
  /** Null = active; non-null = belongs to that archived snapshot. */
  archive_id: number | null;
}
