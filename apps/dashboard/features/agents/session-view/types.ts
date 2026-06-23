/**
 * Shape used when we roundtrip `role_assignments` through the PATCH
 * endpoint. We only read/write a handful of fields — the other optionals
 * (tier, skills, systemPromptOverride, etc.) pass through untouched via
 * object spread so adding fields to the backend interface later doesn't
 * require changes here.
 */
export type RoleAssignmentRaw = {
  role: string;
  provider: string;
  model: string;
  tier?: string;
  skills?: string[];
  projectHints?: string[];
  projectIds?: number[];
  systemPromptOverride?: string;
  [k: string]: unknown;
};

export interface SessionProject {
  project_id: number;
  project_name: string;
  root_path: string;
  label: string | null;
}

export interface AvailableProject {
  id: number;
  name: string;
  root_path: string;
}

export interface PersistedAgentRun {
  id: number;
  role: string;
  status: string;
  provider: string;
  model: string;
  project_ids_json: string;
  coder_session_id: number;
}

export function parseConfig(json: string): Record<string, unknown> | null {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
