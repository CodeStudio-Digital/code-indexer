/**
 * Scope-aware persistence for the pipeline builder.
 *
 * The same visual builder serves two worlds:
 *   - `company`  — multi-project pipelines saved under `/company/pipelines`
 *                  (owner = a company session).
 *   - `project`  — single-project pipelines saved under a chat session's
 *                  `/coder/sessions/:id/pipelines` (owner = the project).
 *
 * Centralising the endpoint choice here keeps `PipelineBuilder` free of
 * scope branching and lets a future scope reuse the same builder.
 */
import { useMemo } from 'react';
import { apiPost, apiPatch } from '../../../../hooks/useApi.js';
import type { Pipeline, PipelineGraph } from '@mcp/company/types.js';

export type PipelineBuilderScope =
  | { kind: 'company'; companySessionId: string }
  // `projectId` is optional — the coder routes derive the owning project
  // from the session server-side; it's kept for callers that already have it.
  | { kind: 'project'; coderSessionId: string; projectId?: number };

export interface PipelineValidationResult {
  ok: boolean;
  errors: Array<{ nodeId?: string; edgeId?: string; message: string }>;
}

export interface SaveArgs {
  pipeline: Pipeline | null;
  name: string;
  description: string;
  graph: PipelineGraph;
}

export interface GenerateResult {
  graph?: PipelineGraph;
  summary?: string;
  refusal?: string;
  issues?: Array<{ message: string }>;
}

export interface PipelinePersistence {
  validate: (
    graph: PipelineGraph,
    pipelineId: number | string | null,
  ) => Promise<PipelineValidationResult>;
  save: (args: SaveArgs) => Promise<Pipeline>;
  /** Ask the AI to draft a graph from a natural-language description. */
  generate: (intent: string, availableRoles: string[]) => Promise<GenerateResult>;
}

export function usePipelinePersistence(scope: PipelineBuilderScope): PipelinePersistence {
  return useMemo<PipelinePersistence>(() => {
    if (scope.kind === 'company') {
      const { companySessionId } = scope;
      return {
        validate: (graph, pipelineId) =>
          apiPost<PipelineValidationResult>(`/company/pipelines/${pipelineId ?? 0}/validate`, {
            graph,
            session_id: companySessionId,
          }),
        save: ({ pipeline, name, description, graph }) =>
          pipeline
            ? apiPatch<Pipeline>(`/company/pipelines/${pipeline.id}`, {
                name,
                description,
                graph,
                expected_version: pipeline.version,
              })
            : apiPost<Pipeline>('/company/pipelines', {
                name,
                description,
                graph,
                company_session_id: companySessionId,
              }),
        generate: (intent, availableRoles) =>
          apiPost<GenerateResult>('/company/pipelines/generate', {
            intent,
            available_roles: availableRoles,
          }),
      };
    }

    const base = `/coder/sessions/${scope.coderSessionId}/pipelines`;
    return {
      validate: (graph) => apiPost<PipelineValidationResult>(`${base}/validate`, { graph }),
      save: ({ pipeline, name, description, graph }) =>
        pipeline
          ? apiPatch<Pipeline>(`${base}/${pipeline.id}`, {
              name,
              description,
              graph,
              expected_version: pipeline.version,
            })
          : apiPost<Pipeline>(base, { name, description, graph }),
      generate: (intent) => apiPost<GenerateResult>(`${base}/generate`, { intent }),
    };
  }, [scope]);
}
