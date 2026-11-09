export type BoardKind = 'message' | 'decision' | 'question' | 'deliverable' | 'handoff' | 'blocker';

/** Original file in the owning Company's content-addressed attachment store. */
export interface BoardAttachment {
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
}

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
  attachments?: BoardAttachment[];
  mentions: string[];
  created_at: string;
  /** Null = active; non-null = belongs to that archived snapshot. */
  archive_id: string | null;
}
