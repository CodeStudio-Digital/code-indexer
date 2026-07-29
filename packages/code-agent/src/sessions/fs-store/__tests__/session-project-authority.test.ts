import { describe, expect, it } from 'vitest';
import { asSessionId } from '@mcp/agent-runtime-contracts';
import type { FsCoderSession } from '../types.js';
import {
  requireSessionProjectAuthority,
  resolveSessionProjectAuthority,
} from '../session-project-authority.js';

const globalSession = {
  is_global: true,
  project_id: 7,
  linked_projects: [
    {
      project_id: 7,
      name: 'Persisted Alpha',
      root_path: 'D:\\stale-alpha',
      is_primary: true,
      label: 'main',
    },
    {
      project_id: 8,
      name: 'Persisted Beta',
      root_path: 'D:\\stale-beta',
      is_primary: false,
      label: null,
    },
  ],
} satisfies Pick<
  FsCoderSession,
  'is_global' | 'project_id' | 'linked_projects'
>;

describe('filesystem session project authority', () => {
  it('allows execution through another current link after the primary is removed', () => {
    const authority = resolveSessionProjectAuthority(
      globalSession,
      (projectId) => projectId === 8
        ? {
            project_id: 8,
            name: 'Current Beta',
            root_path: 'D:\\current-beta',
          }
        : null,
    );

    expect(authority).toEqual({
      primary: expect.objectContaining({
        project_id: 8,
        root_path: 'D:\\current-beta',
        is_primary: true,
      }),
      projects: [{
        project_id: 8,
        name: 'Current Beta',
        root_path: 'D:\\current-beta',
        is_primary: true,
        label: null,
      }],
    });
    expect(
      authority?.projects.some(
        (project) => project.root_path.includes('stale'),
      ),
    ).toBe(false);
  });

  it('fails execution when every linked project is absent', () => {
    expect(
      () => requireSessionProjectAuthority(
        {
          id: asSessionId('11111111-1111-4111-8111-111111111111'),
          ...globalSession,
        },
        () => null,
      ),
    ).toThrow('no available project in the current catalog');
  });

  it('rejects empty current roots instead of resolving them as cwd', () => {
    expect(
      resolveSessionProjectAuthority(globalSession, (projectId) => ({
        project_id: projectId,
        name: String(projectId),
        root_path: '',
      })),
    ).toBeNull();
  });
});
