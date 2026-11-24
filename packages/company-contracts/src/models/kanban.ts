import { z } from 'zod';

export type KanbanColumn = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done';
export type KanbanTag = 'bug' | 'feature' | 'refactor' | 'documentation';

export const KANBAN_COLUMNS: KanbanColumn[] = ['backlog', 'todo', 'in_progress', 'review', 'done'];

export const taskControl = z.object({
  owner: z.string().trim().min(1).max(80).nullable(),
  projectId: z.number().int().positive().nullable(),
  acceptance: z.array(z.object({ criterion:z.string().trim().min(1).max(500), evidence:z.string().trim().max(2000) })).max(30),
  visualQA: z.boolean(),
});
export type TaskControl = z.infer<typeof taskControl>;
export type TaskAcceptance = TaskControl['acceptance'][number];
export const taskEvidence = z.array(z.object({
  index: z.number().int().min(0).max(29),
  criterion: z.string().trim().min(1).max(500),
  evidence: z.string().trim().min(1).max(2000),
})).min(1).max(30);
export type TaskEvidence = z.infer<typeof taskEvidence>;
export interface KanbanCard {
  control?: TaskControl;
  transitions?: Array<{from:KanbanColumn;to:KanbanColumn;at:string;actor:string;reason?:string}>;
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
  session_id?: string;
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
