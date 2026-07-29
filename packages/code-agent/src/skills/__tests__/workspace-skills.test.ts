import { describe, expect, it } from 'vitest';
import type { SkillDefinition } from '@mcp/store/skill-store.js';
import { resolveActiveWorkspaceSkills } from '../workspace-skills.js';

function skill(
  id: string,
  scope: string,
  options: { enabled?: boolean; sortOrder?: number } = {},
): SkillDefinition {
  return {
    id,
    name: id,
    description: id,
    slash_command: null,
    prompt_body: '',
    scope,
    enabled: options.enabled ?? true,
    allowed_tools: null,
    model_override: null,
    provider_override: null,
    context_mode: 'auto',
    variables: [],
    sort_order: options.sortOrder ?? 0,
    path_patterns: null,
    trigger_paths: null,
    trigger_roles: null,
    tags: [],
    source: 'user',
    author: null,
    version: '1',
    source_ref: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('resolveActiveWorkspaceSkills', () => {
  it('aggregates project skills and deduplicates shared global entries', () => {
    const calls: string[] = [];
    const resolved = resolveActiveWorkspaceSkills({
      listSkills(filter) {
        const scope = filter?.scope ?? '';
        calls.push(scope);
        if (scope === 'global') {
          return [skill('global-guidance', 'global')];
        }
        return scope === '7'
          ? [skill('global-guidance', '7'), skill('backend-only', '7')]
          : [skill('global-guidance', '11'), skill('intranet-only', '11')];
      },
    }, [7, 11]);

    expect(calls).toEqual(['global', '7', '11']);
    expect(resolved.map((entry) => entry.id)).toEqual([
      'backend-only',
      'global-guidance',
      'intranet-only',
    ]);
  });

  it('uses the filesystem active-skill projection when it is present', () => {
    const resolved = resolveActiveWorkspaceSkills({
      listSkills(filter) {
        return filter?.scope === 'global'
          ? [
              skill('enabled-by-default', 'global'),
              skill('explicitly-enabled', 'global', { enabled: false }),
            ]
          : [];
      },
    }, [7], ['explicitly-enabled']);

    expect(resolved.map((entry) => entry.id)).toEqual([
      'explicitly-enabled',
    ]);
  });

  it('falls back to enabled definitions for sessions without a projection', () => {
    const resolved = resolveActiveWorkspaceSkills({
      listSkills(filter) {
        return filter?.scope === 'global'
          ? [
              skill('enabled-by-default', 'global'),
              skill('disabled-by-default', 'global', { enabled: false }),
            ]
          : [];
      },
    }, []);

    expect(resolved.map((entry) => entry.id)).toEqual([
      'enabled-by-default',
    ]);
  });
});
