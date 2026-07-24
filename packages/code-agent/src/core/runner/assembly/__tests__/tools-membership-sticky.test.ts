import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import {
  buildTools,
  enforceAtomicGoalToolPair,
  fingerprintTools,
} from '@mcp/code-agent/core/runner/assembly/tools.js';
import { profileToTiers } from '@mcp/code-agent/tools/tiers.js';
import { resolveSessionProfile, type PersistedToolsetState } from '@mcp/code-agent/tools/profile-resolution.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';

/**
 * Cross-RUN membership stability (mig 142). The create_goal incident pinned
 * the within-run invariant (tools-array-stability.test.ts); session 991
 * showed the cross-run version: re-inferring the profile from whatever tail
 * was loaded flipped the tool array between rounds (118 ↔ ~60), busting the
 * provider prompt-cache prefix at every round's turn 1. With the persisted
 * profile + pins, two resumes with DIFFERENT loaded tails must serialize a
 * byte-identical tools array.
 */

function makeTool(name: string, description = `desc for ${name}`): CoderTool {
  return {
    name,
    description,
    source: 'native',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => ({ content: '' }),
  };
}

// Real tier names (tiers.ts): read_file/list_directory=bootstrap,
// edit_file/write_file=navigate, git_commit/git_add=admin.
const CATALOG = ['read_file', 'list_directory', 'edit_file', 'write_file', 'git_commit', 'git_add'];

function buildForResume(tail: string[], persisted: PersistedToolsetState): string {
  const resolved = resolveSessionProfile({
    hasHistory: true,
    stickyEnabled: true,
    persisted,
    historyToolNames: tail,
  });
  const registry = new ToolRegistry();
  registry.registerAll(CATALOG.map((n) => makeTool(n)));
  const built = buildTools({
    registry,
    activeTiers: profileToTiers(resolved.profile),
    pinnedTools: new Set(persisted.pins),
    toolContext: { cwd: tmpdir(), projectName: 'test' } as unknown as ToolContext,
    provider: { name: 'chatgpt', model: 'gpt-5.5' } as unknown as Parameters<typeof buildTools>[0]['provider'],
  });
  return fingerprintTools(built.tools);
}

describe('sticky toolset — byte-identical array across resumes with different tails', () => {
  const persisted: PersistedToolsetState = {
    profile: 'full',
    extraTiers: [],
    pins: ['mcp__search'],
    visibleCap: null,
  };

  it('same fingerprint whether the loaded tail shows bootstrap-only or admin calls', () => {
    const fpA = buildForResume(['read_file'], persisted);                 // tail lost the admin turns
    const fpB = buildForResume(['read_file', 'git_commit'], persisted);   // tail kept them
    expect(fpA).toBe(fpB);
  });

  it('legacy behavior (no stamp) DOES flip — documents the bug the stamp fixes', () => {
    const resolve = (tail: string[]) => resolveSessionProfile({
      hasHistory: true, stickyEnabled: true, persisted: null, historyToolNames: tail,
    }).profile;
    expect(resolve(['mcp__read_file'])).toBe('bootstrap');
    expect(resolve(['read_file', 'git_commit'])).toBe('full');
  });

  it('persisted pins keep a hidden tool in the array even when the tail forgot it', () => {
    const registry = new ToolRegistry();
    registry.registerAll([...CATALOG, 'mcp__search'].map((n) => makeTool(n)));
    const built = buildTools({
      registry,
      activeTiers: profileToTiers('bootstrap'),
      pinnedTools: new Set(['mcp__search']), // navigate-tier tool pinned in a prior run
      toolContext: { cwd: tmpdir(), projectName: 'test' } as unknown as ToolContext,
      provider: { name: 'chatgpt', model: 'gpt-5.5' } as unknown as Parameters<typeof buildTools>[0]['provider'],
    });
    expect(built.tools.map((t) => t.name)).toContain('mcp__search');
  });

  it('removes both goal transitions when update_goal is disabled', () => {
    const registry = new ToolRegistry();
    registry.registerAll([
      makeTool('create_goal'),
      makeTool('update_goal'),
      makeTool('read_file'),
    ]);
    const built = buildTools({
      registry,
      sessionDisabledTools: new Set(['update_goal']),
      activeTiers: null,
      toolContext: { cwd: tmpdir(), projectName: 'test' } as unknown as ToolContext,
      provider: { name: 'chatgpt', model: 'gpt-5.5' } as unknown as Parameters<typeof buildTools>[0]['provider'],
    });

    expect(built.tools.map((tool) => tool.name)).toEqual(['read_file']);
  });

  it('removes both goal transitions when create_goal is disabled', () => {
    const registry = new ToolRegistry();
    registry.registerAll([
      makeTool('create_goal'),
      makeTool('update_goal'),
      makeTool('read_file'),
    ]);
    const built = buildTools({
      registry,
      globalDisabledTools: new Set(['create_goal']),
      activeTiers: null,
      toolContext: { cwd: tmpdir(), projectName: 'test' } as unknown as ToolContext,
      provider: { name: 'chatgpt', model: 'gpt-5.5' } as unknown as Parameters<typeof buildTools>[0]['provider'],
    });

    expect(built.tools.map((tool) => tool.name)).toEqual(['read_file']);
  });

  it('normalizes arbitrary post-build subsets without perturbing coherent arrays', () => {
    const both = [{ name: 'create_goal' }, { name: 'read_file' }, { name: 'update_goal' }];
    const neither = [{ name: 'read_file' }];

    expect(enforceAtomicGoalToolPair(both)).toBe(both);
    expect(enforceAtomicGoalToolPair(neither)).toBe(neither);
    expect(enforceAtomicGoalToolPair([
      { name: 'create_goal' },
      { name: 'read_file' },
    ])).toEqual([{ name: 'read_file' }]);
    expect(enforceAtomicGoalToolPair([
      { name: 'read_file' },
      { name: 'update_goal' },
    ])).toEqual([{ name: 'read_file' }]);
    expect(enforceAtomicGoalToolPair(
      [{ name: 'read_file' }],
      both,
    )).toEqual(both);
  });
});
