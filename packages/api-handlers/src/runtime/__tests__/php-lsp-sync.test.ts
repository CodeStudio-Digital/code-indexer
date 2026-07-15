import { describe, expect, it, vi } from 'vitest';
import type { InstallProgress } from '@mcp/api-bus';
import type { Project } from '@mcp/shared/types.js';
import {
  projectsUsingManagedPhpVersion,
  refreshAfterSuccessfulPhpExtensionInstall,
  refreshRunningIntelephense,
} from '../php-lsp-sync.js';

function project(id: number, phpRuntime?: string): Project {
  return { id, runtime_versions: phpRuntime ? JSON.stringify({ php: phpRuntime }) : null } as Project;
}

describe('php-lsp-sync', () => {
  it('selects only projects using the changed managed PHP version', () => {
    expect(projectsUsingManagedPhpVersion([
      project(1, 'managed:8.3.7'),
      project(2, 'managed:8.4.1'),
      project(3, 'system'),
      project(4),
    ], '8.3.7')).toEqual([1]);
  });

  it('restarts only ready or starting Intelephense instances', async () => {
    const projects = [project(1, 'managed:8.3.7'), project(2, 'managed:8.3.7'), project(3, 'managed:8.3.7')];
    const restart = vi.fn(async () => undefined);
    const states = new Map([[1, 'ready'], [2, 'starting'], [3, 'idle']]);
    await refreshRunningIntelephense(
      { listProjects: () => projects },
      { status: (id) => ({ state: states.get(id) ?? 'idle' }), restart },
      '8.3.7',
    );
    expect(restart.mock.calls).toEqual([
      [1, 'intelephense'],
      [2, 'intelephense'],
    ]);
  });

  it('refreshes PECL changes only after a successful done frame', async () => {
    const doneRefresh = vi.fn(async () => undefined);
    async function* successful(): AsyncGenerator<InstallProgress> {
      yield { kind: 'php', phase: 'install', version: '8.3.7' };
      yield { kind: 'php', phase: 'done', version: '8.3.7' };
    }
    const successfulFrames: InstallProgress[] = [];
    for await (const frame of refreshAfterSuccessfulPhpExtensionInstall(successful(), doneRefresh)) {
      successfulFrames.push(frame);
    }
    expect(successfulFrames.map((frame) => frame.phase)).toEqual(['install', 'done']);
    expect(doneRefresh).toHaveBeenCalledOnce();

    const failedRefresh = vi.fn(async () => undefined);
    async function* incomplete(): AsyncGenerator<InstallProgress> {
      yield { kind: 'php', phase: 'install', version: '8.3.7' };
    }
    for await (const _frame of refreshAfterSuccessfulPhpExtensionInstall(incomplete(), failedRefresh)) {
      // drain
    }
    expect(failedRefresh).not.toHaveBeenCalled();
  });
});
