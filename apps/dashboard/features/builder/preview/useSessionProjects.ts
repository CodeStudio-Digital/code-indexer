import { useApi } from '../../../hooks/useApi.js';

export interface SessionProject {
  project_id: number;
  project_name: string;
  root_path: string;
  label: string | null;
}

interface SessionResponse {
  projects: SessionProject[];
}

/**
 * Fetches the projects linked to a company session. Shared by FilesTab
 * and GitTab via the parent container so each tab doesn't refetch.
 */
export function useSessionProjects(sessionId: string) {
  const { data, loading, error, refetch } = useApi<SessionResponse>(
    `/company/sessions/${sessionId}`,
  );
  return {
    projects: data?.projects ?? [],
    loading,
    error,
    refetch,
  };
}
