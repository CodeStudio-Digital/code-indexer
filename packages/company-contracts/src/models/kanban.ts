export type KanbanColumn = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done';
export type KanbanTag = 'bug' | 'feature' | 'refactor' | 'documentation';

export const KANBAN_COLUMNS: KanbanColumn[] = ['backlog', 'todo', 'in_progress', 'review', 'done'];

export interface KanbanCard {
  id: string;
  seq: number;
  company_session_id: string;
  title: string;
  description: string;
  column: KanbanColumn;
  position: number;
  tag: KanbanTag | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  /** Null = active; non-null = belongs to that archived snapshot. */
  archive_id: string | null;
}

export interface KanbanChecklistItem {
  id: string;
  card_id: string;
  text: string;
  checked: boolean;
  position: number;
}

export interface KanbanComment {
  id: string;
  card_id: string;
  author_role: string;
  agent_run_id: string | null;
  content: string;
  created_at: string;
}

export interface KanbanCardAgent {
  id: string;
  card_id: string;
  agent_run_id: string;
  role: string;
  assigned_at: string;
  unassigned_at: string | null;
}

export interface KanbanCardDependency {
  id: string;
  card_id: string;
  depends_on_id: string;
  created_at: string;
}

export interface KanbanCardFull extends KanbanCard {
  checklist: KanbanChecklistItem[];
  comments: KanbanComment[];
  agents: KanbanCardAgent[];
  dependencies: KanbanCardDependency[];
  /** IDs of depends_on cards that are NOT in 'done' column */
  blocked_by: string[];
}
