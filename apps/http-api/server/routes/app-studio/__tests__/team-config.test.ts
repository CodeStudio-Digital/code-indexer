import { describe, expect, it } from 'vitest';
import { applyAppTeamConfigPatch, readAppTeamConfig, type AppTeamRoleConfig } from '../team-config.js';

const initialConfig = JSON.stringify({
  runtime_kind: 'app_studio',
  app_session_id: 41,
  work_source: 'app_studio_workflow',
  autonomy: { scheduler: true },
  master_provider: 'openai',
  master_model: 'gpt-primary',
  master_tier: 'navigate',
  master_fallback_provider: 'anthropic',
  master_fallback_model: 'claude-fallback',
  master_initial_tools: ['app_get_state', 'find_tools'],
  master_system_prompt_override: 'Coordinate with evidence.',
  operational_rules: 'Never skip tests.',
  role_assignments: [{
    role: 'frontend',
    enabled: true,
    provider: 'openai',
    model: 'gpt-primary',
    tier: 'full',
    projectIds: [7],
    skills: ['ui'],
    initialTools: ['preview_screenshot', 'find_tools'],
    systemPromptOverride: 'Own the rendered experience.',
    fallbackModels: [{ provider: 'anthropic', model: 'claude-fallback' }],
  }],
  allowed_models: [
    { provider: 'openai', model: 'gpt-primary', label: 'App default', is_default: true },
    { provider: 'anthropic', model: 'claude-fallback', label: 'Explicit fallback', is_default: false },
  ],
});

describe('App team config facade', () => {
  it('projects the Master and specialists from the canonical Company config', () => {
    const view = readAppTeamConfig(initialConfig, 90, 'running');
    expect(view).toMatchObject({
      company_session_id: 90,
      status: 'running',
      operational_rules: 'Never skip tests.',
    });
    expect(view.roles.map((role) => role.role)).toEqual(['master', 'frontend']);
    expect(view.roles[0].fallbackModels).toEqual([{ provider: 'anthropic', model: 'claude-fallback' }]);
    expect(view.roles[0].initialTools).toEqual(['app_get_state', 'find_tools']);
    expect(view.roles[0].systemPromptOverride).toBe('Coordinate with evidence.');
    expect(view.roles[0].availableToolNames).toEqual(expect.arrayContaining([
      'app_update_plan',
      'app_dispatch_ready_work',
      'list_subordinates',
    ]));
    expect(view.roles[0].availableToolNames).not.toContain('spawn_subordinate_agent');
    expect(view.roles[0].availableToolNames).not.toContain('kanban_create_card');
    expect(view.roles[1].projectIds).toEqual([7]);
    expect(view.roles[1].initialTools).toEqual(['preview_screenshot', 'find_tools']);
    expect(view.roles[1].availableToolNames).toEqual(expect.arrayContaining([
      'app_get_state',
      'app_get_plan',
      'app_run_checks',
      'app_record_work_evidence',
      'preview_screenshot',
    ]));
    expect(view.roles[1].availableToolNames).not.toContain('app_update_plan');
    expect(view.roles[1].availableToolNames).not.toContain('kanban_read_my_card');
  });

  it('writes roles once and derives the runtime allowlist from them', () => {
    const roles: AppTeamRoleConfig[] = [
      {
        role: 'master', enabled: true, provider: 'google', model: 'gemini-primary', tier: 'full',
        skills: ['coordination'], initialTools: ['app_get_plan', 'find_tools'], systemPromptOverride: 'Coordinate only.', fallbackModels: [{ provider: 'openai', model: 'gpt-backup' }],
      },
      {
        role: 'frontend', enabled: true, provider: 'anthropic', model: 'claude-ui', tier: 'full',
        projectIds: [7], skills: ['ui'], initialTools: ['preview_screenshot', 'find_tools'], fallbackModels: [{ provider: 'openai', model: 'gpt-backup' }],
      },
    ];
    const result = applyAppTeamConfigPatch(initialConfig, { roles });
    const stored = JSON.parse(result.configJson) as Record<string, unknown>;
    expect(stored).toMatchObject({
      runtime_kind: 'app_studio',
      app_session_id: 41,
      master_provider: 'google',
      master_model: 'gemini-primary',
      master_tier: 'navigate',
      master_fallback_provider: 'openai',
      master_fallback_model: 'gpt-backup',
      master_skills: ['coordination'],
      master_initial_tools: ['app_get_plan', 'find_tools'],
      master_system_prompt_override: 'Coordinate only.',
    });
    expect(stored.role_assignments).toEqual([expect.objectContaining({
      role: 'frontend',
      projectIds: [7],
      initialTools: ['preview_screenshot', 'find_tools'],
    })]);
    expect(result.allowedModels.map(({ provider, model, is_default }) => ({ provider, model, is_default }))).toEqual([
      { provider: 'google', model: 'gemini-primary', is_default: true },
      { provider: 'openai', model: 'gpt-backup', is_default: false },
      { provider: 'anthropic', model: 'claude-ui', is_default: false },
    ]);
  });

  it('updates rules without touching roles', () => {
    const result = applyAppTeamConfigPatch(initialConfig, { operational_rules: '  Ship with evidence.  ' });
    expect(JSON.parse(result.configJson)).toMatchObject({
      operational_rules: 'Ship with evidence.',
      master_provider: 'openai',
      role_assignments: [expect.objectContaining({ role: 'frontend' })],
    });
    expect(result.changedKeys).toEqual(['operational_rules']);
  });

  it('rejects duplicate roles and a fallback equal to the primary model', () => {
    const view = readAppTeamConfig(initialConfig, 90, 'idle');
    expect(() => applyAppTeamConfigPatch(initialConfig, { roles: [...view.roles, view.roles[1]] })).toThrow('role names must be unique');
    const invalid = view.roles.map((role) => role.role === 'frontend'
      ? { ...role, fallbackModels: [{ provider: role.provider, model: role.model }] }
      : role);
    expect(() => applyAppTeamConfigPatch(initialConfig, { roles: invalid })).toThrow("fallback must differ");
  });
});
