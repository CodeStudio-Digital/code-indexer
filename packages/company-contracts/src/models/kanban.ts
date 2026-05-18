export type KanbanColumn = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done';
export type KanbanTag = 'bug' | 'feature' | 'refactor' | 'documentation';

export const KANBAN_COLUMNS: KanbanColumn[] = ['backlog', 'todo', 'in_progress', 'review', 'done'];

export interface KanbanCard {
  id: number;
  company_session_id: number;
  title: string;
  description: string;
  column: KanbanColumn;
  position: number;
  tag: KanbanTag | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  /** Null = active; non-null = belongs to that archived snapshot. */
  archive_id: number | null;
}

export interface KanbanChecklistItem {
  id: number;
  card_id: number;
  text: string;
  checked: boolean;
  position: number;
}

export interface KanbanComment {
  id: number;
  card_id: number;
  author_role: string;
  agent_run_id: number | null;
  content: string;
  created_at: string;
}

export interface KanbanCardAgent {
  id: number;
  card_id: number;
  agent_run_id: number;
  role: string;
  assigned_at: string;
  unassigned_at: string | null;
}

export interface KanbanCardDependency {
  id: number;
  card_id: number;
  depends_on_id: number;
  created_at: string;
}

export interface KanbanCardFull extends KanbanCard {
  checklist: KanbanChecklistItem[];
  comments: KanbanComment[];
  agents: KanbanCardAgent[];
  dependencies: KanbanCardDependency[];
  /** IDs of depends_on cards that are NOT in 'done' column */
  blocked_by: number[];
}
