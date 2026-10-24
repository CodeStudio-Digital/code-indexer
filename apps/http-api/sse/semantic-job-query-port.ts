import type { SemanticJobRow } from '@mcp/store/semantic-store.js';

export interface ProjectJobScope { projectId: number; generationIds: number[]; pausedOnly?: boolean }
export interface ProjectJobsPageInput { namespaces: string[]; limit?: number; beforeId?: number }
export interface ProjectJobsPage { jobs: SemanticJobRow[]; nextBeforeId: number | null }
export interface SemanticJobQueryPort {
  currentProjectJobs(scopes: ProjectJobScope[], signal?: AbortSignal): Promise<Array<SemanticJobRow | null>>;
  projectJobsPage(input: ProjectJobsPageInput, signal?: AbortSignal): Promise<ProjectJobsPage>;
}
