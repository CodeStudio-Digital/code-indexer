interface GlobalSearchProject {
  id: number;
  name: string;
}

type GlobalSearchProjectResult<TResult> =
  | {
      ok: true;
      project: GlobalSearchProject;
      results: TResult;
      error: null;
    }
  | {
      ok: false;
      project: GlobalSearchProject;
      results: null;
      error: unknown;
    };

/**
 * Runs independent per-project searches with bounded concurrency.
 *
 * Results retain the input project order even when searches settle out of
 * order. A project failure is captured in its own slot so one unavailable
 * vector database cannot cancel the remaining global search.
 */
export async function searchProjectsConcurrently<TResult>(
  projects: readonly GlobalSearchProject[],
  searchProject: (project: GlobalSearchProject) => Promise<TResult>,
  concurrency = 4,
): Promise<Array<GlobalSearchProjectResult<TResult>>> {
  if (projects.length === 0) return [];

  const workerCount = Math.min(
    projects.length,
    Math.max(1, Math.min(4, Math.floor(concurrency) || 1)),
  );
  const results = new Array<GlobalSearchProjectResult<TResult>>(projects.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < projects.length) {
      const index = cursor++;
      const project = projects[index];
      try {
        results[index] = {
          ok: true,
          project,
          results: await searchProject(project),
          error: null,
        };
      } catch (error) {
        results[index] = { ok: false, project, results: null, error };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
