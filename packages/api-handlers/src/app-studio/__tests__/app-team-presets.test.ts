import { describe, expect, it } from 'vitest';
import { allTieredToolNames } from '@mcp/code-agent/tools/tiers.js';
import { APP_TEAM_ROLE_PRESETS, appTeamRolePreset } from '../app-team-presets.js';

describe('App Studio team role presets', () => {
  it('defines one editable prompt and initial tool catalog for every canonical role', () => {
    expect(APP_TEAM_ROLE_PRESETS.map((preset) => preset.role)).toEqual([
      'master',
      'research',
      'architect',
      'backend',
      'frontend',
      'database',
      'ux',
      'qa',
      'fullstack',
    ]);

    for (const preset of APP_TEAM_ROLE_PRESETS) {
      expect(preset.systemPromptOverride.length, preset.role).toBeGreaterThan(300);
      expect(preset.systemPromptOverride, preset.role).toContain('find_tools');
      expect(preset.systemPromptOverride, preset.role).toContain('expand_toolset');
      expect(preset.initialTools.length, preset.role).toBeGreaterThan(0);
      expect(new Set(preset.initialTools).size, preset.role).toBe(preset.initialTools.length);
      expect(preset.initialTools, preset.role).toContain('find_tools');
    }
  });

  it('only references tools that belong to the canonical runtime catalog', () => {
    const catalog = allTieredToolNames();
    for (const preset of APP_TEAM_ROLE_PRESETS) {
      const unknown = preset.initialTools.filter((tool) => !catalog.has(tool));
      expect(unknown, preset.role).toEqual([]);
    }
  });

  it('looks up a role without inventing a fallback preset', () => {
    expect(appTeamRolePreset('frontend')?.tier).toBe('full');
    expect(appTeamRolePreset('not-a-role')).toBeNull();
  });
});
