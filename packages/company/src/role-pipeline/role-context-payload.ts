
export interface RoleContextPayload {
  /** Relevant file paths for the role (e.g. from HybridSearch on the task text). */
  relevantFiles?: ReadonlyArray<{ path: string; score?: number }>;
  /** Kanban card titles assigned to or blocking this role. */
  kanbanCards?: ReadonlyArray<{ id: string; title: string; status?: string }>;
  /** Free-form notes the orchestrator can prepend to the role's system prompt. */
  notes?: string;
}
