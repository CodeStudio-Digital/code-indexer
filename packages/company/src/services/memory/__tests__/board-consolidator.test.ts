/**
 * Board → project-memory consolidation. Verifies attribution (run →
 * project, master/system → all session projects), kind filtering, the
 * memory_enabled gate and the never-throws posture.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { consolidateBoardToMemory, type ConsolidateBoardDeps } from '../board-consolidator.js';
import { setCompanyMemoryPorts } from '../ports.js';

interface Entry {
  agent_run_id: string | null;
  author_role: string;
  kind: string;
  content: string;
}

function makeDeps(entries: Entry[], opts?: { memoryEnabled?: (id: number) => boolean }): ConsolidateBoardDeps {
  return {
    companySessionId: 'c0000000-0000-4000-8000-000000000009',
    companyFiles: {
      listBoardEntriesSync: () => entries,
      listAgentRunsSync: () => [
        { id: 'a0000000-0000-4000-8000-000000000001', role: 'master', project_ids_json: '[10,20]' },
        { id: 'a0000000-0000-4000-8000-000000000002', role: 'frontend', project_ids_json: '[10]' },
        { id: 'a0000000-0000-4000-8000-000000000003', role: 'backend', project_ids_json: '[20]' },
      ],
    },
    db: {
      getProjectMemoryEnabled: opts?.memoryEnabled ?? (() => true),
      getProject: (id) => ({ name: `proj-${id}` }),
    },
    projects: [{ project_id: 10 }, { project_id: 20 }],
  };
}

function wirePorts() {
  const extractAndPersist = vi.fn().mockResolvedValue(undefined);
  setCompanyMemoryPorts({
    memoryRetriever: { retrieve: vi.fn().mockResolvedValue([]) },
    runEndMemory: { extractAndPersist, isConfigured: vi.fn().mockResolvedValue(true) },
  });
  return extractAndPersist;
}

afterEach(() => setCompanyMemoryPorts(null));

describe('consolidateBoardToMemory', () => {
  it('groups entries per project and forwards blockers as errorsAndFixes', async () => {
    const extract = wirePorts();
    const res = await consolidateBoardToMemory(
      makeDeps([
        { agent_run_id: 'a0000000-0000-4000-8000-000000000002', author_role: 'frontend', kind: 'decision', content: 'Use zustand.' },
        { agent_run_id: 'a0000000-0000-4000-8000-000000000003', author_role: 'backend', kind: 'blocker', content: 'Port 5432 busy.' },
        { agent_run_id: 'a0000000-0000-4000-8000-000000000002', author_role: 'frontend', kind: 'message', content: 'chatter — must be skipped' },
        { agent_run_id: null, author_role: 'system', kind: 'deliverable', content: 'Session shipped.' },
      ]),
    );
    expect(res).toEqual({ projects: 2, entries: 3 });
    expect(extract).toHaveBeenCalledTimes(2);

    const byProject = new Map(extract.mock.calls.map((c) => [c[0], c[2]]));
    // project 10: frontend decision + system deliverable (all-projects)
    expect(byProject.get(10).summary).toContain('Use zustand.');
    expect(byProject.get(10).summary).toContain('Session shipped.');
    expect(byProject.get(10).summary).not.toContain('chatter');
    expect(byProject.get(10).errorsAndFixes).toBeUndefined();
    // project 20: backend blocker lands in both summary and errorsAndFixes
    expect(byProject.get(20).summary).toContain('Port 5432 busy.');
    expect(byProject.get(20).errorsAndFixes?.[0]).toContain('Port 5432 busy.');
  });

  it('respects the per-project memory_enabled gate', async () => {
    const extract = wirePorts();
    const res = await consolidateBoardToMemory(
      makeDeps(
        [{ agent_run_id: null, author_role: 'master', kind: 'decision', content: 'd' }],
        { memoryEnabled: (id) => id === 10 },
      ),
    );
    expect(res.projects).toBe(1);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract.mock.calls[0][0]).toBe(10);
  });

  it('no-ops without ports, without distiller binding, or on empty board', async () => {
    expect(await consolidateBoardToMemory(makeDeps([{ agent_run_id: 'a0000000-0000-4000-8000-000000000002', author_role: 'f', kind: 'decision', content: 'x' }])))
      .toEqual({ projects: 0, entries: 0 }); // no ports wired

    setCompanyMemoryPorts({
      memoryRetriever: { retrieve: vi.fn() },
      runEndMemory: { extractAndPersist: vi.fn(), isConfigured: vi.fn().mockResolvedValue(false) },
    });
    expect(await consolidateBoardToMemory(makeDeps([{ agent_run_id: 'a0000000-0000-4000-8000-000000000002', author_role: 'f', kind: 'decision', content: 'x' }])))
      .toEqual({ projects: 0, entries: 0 }); // distiller not configured

    wirePorts();
    expect(await consolidateBoardToMemory(makeDeps([]))).toEqual({ projects: 0, entries: 0 });
  });

  it('never throws — store errors degrade to zero counts', async () => {
    wirePorts();
    const deps = makeDeps([]);
    deps.companyFiles.listBoardEntriesSync = () => {
      throw new Error('filesystem read failed');
    };
    await expect(consolidateBoardToMemory(deps)).resolves.toEqual({ projects: 0, entries: 0 });
  });
});
