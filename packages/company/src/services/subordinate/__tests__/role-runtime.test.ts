import { describe, expect, it } from 'vitest';
import {
  readRoleRuntimePolicy,
  resolveEffectiveRoleRuntime,
  resolveEffectiveMasterRuntime,
  resolveRoleFallback,
  type ResolveEffectiveRoleRuntimeInput,
} from '@mcp/company/services/subordinate/role-runtime.js';
import { parseMasterConfigFromDb } from '@mcp/company/services/master/config-loader.js';

function resolve(overrides: Partial<ResolveEffectiveRoleRuntimeInput> = {}) {
  return resolveEffectiveRoleRuntime({
    role: 'backend',
    runtimeKind: 'company',
    roleConfig: null,
    requested: {},
    allowedModels: [],
    poolDefault: null,
    masterRuntime: { provider: 'openai-chatgpt', model: 'gpt-5.6-terra' },
    dispatchSource: 'company',
    ...overrides,
  });
}

describe('readRoleRuntimePolicy', () => {
  it('reads the persisted role, runtime kind and deterministic pool default', () => {
    const policy = readRoleRuntimePolicy(JSON.stringify({
      runtime_kind: 'app_studio',
      role_assignments: [
        { role: 'backend', provider: 'old', model: 'old', tier: 'navigate' },
        { role: 'backend', provider: 'openai-chatgpt', model: 'gpt-5.6-terra', tier: 'full' },
      ],
      allowed_models: [
        { provider: 'x', model: 'cheap' },
        { provider: 'openai-chatgpt', model: 'gpt-5.6-terra', is_default: true },
      ],
    }), 'backend');

    expect(policy.runtimeKind).toBe('app_studio');
    expect(policy.roleConfig).toMatchObject({
      provider: 'openai-chatgpt', model: 'gpt-5.6-terra', tier: 'full',
    });
    expect(policy.poolDefault).toMatchObject({
      provider: 'openai-chatgpt', model: 'gpt-5.6-terra',
    });
  });

  it('refuses corrupted persisted config instead of silently selecting a default model', () => {
    expect(() => readRoleRuntimePolicy('{bad json', 'backend')).toThrow(/config_json is invalid/);
  });
});

describe('parseMasterConfigFromDb', () => {
  it('lets persisted role_assignments replace stale in-memory runtime fields', () => {
    const parsed = parseMasterConfigFromDb(JSON.stringify({
      role_assignments: [
        { role: 'backend', provider: 'openai-chatgpt', model: 'gpt-5.6-terra', tier: 'full' },
      ],
    }), [
      { role: 'backend', provider: 'openai-chatgpt', model: 'gpt-5.4-mini', tier: 'bootstrap' },
      { role: 'stale', provider: 'p', model: 'm', tier: 'navigate' },
    ], '00000000-0000-4000-8000-000000000001');

    expect(parsed.roleConfigs).toEqual([
      { role: 'backend', provider: 'openai-chatgpt', model: 'gpt-5.6-terra', tier: 'full' },
    ]);
  });
});

describe('resolveEffectiveRoleRuntime', () => {
  it('makes persisted role_assignments authoritative over caller and pool defaults', () => {
    const result = resolve({
      runtimeKind: 'app_studio',
      roleConfig: {
        role: 'backend',
        provider: 'openai-chatgpt',
        model: 'gpt-5.6-terra',
        tier: 'full',
        reasoningEffort: 'xhigh',
        thinking: true,
        initialTools: ['app_get_plan', 'find_tools', 'app_get_plan'],
        fallbackModels: [{ provider: 'openai-chatgpt', model: 'gpt-5.6' }],
      },
      requested: {
        provider: 'openai-chatgpt',
        model: 'gpt-5.4-mini',
        tier: 'bootstrap',
        reasoningEffort: 'minimal',
        thinking: false,
      },
      allowedModels: [
        { provider: 'openai-chatgpt', model: 'gpt-5.6-terra' },
        { provider: 'openai-chatgpt', model: 'gpt-5.6' },
        { provider: 'openai-chatgpt', model: 'gpt-5.4-mini', is_default: true },
      ],
      poolDefault: { provider: 'openai-chatgpt', model: 'gpt-5.4-mini' },
      dispatchSource: 'scheduler',
    });

    expect(result).toMatchObject({
      provider: 'openai-chatgpt',
      model: 'gpt-5.6-terra',
      tier: 'full',
      reasoningEffort: 'xhigh',
      thinking: true,
      initialTools: ['app_get_plan', 'find_tools'],
      configuredProvider: 'openai-chatgpt',
      configuredModel: 'gpt-5.6-terra',
      dispatchSource: 'scheduler',
      resolutionSource: 'role_assignment',
    });
    expect(result.fallbackModels).toEqual([
      { provider: 'openai-chatgpt', model: 'gpt-5.6' },
    ]);
  });

  it('blocks missing and disabled App Studio roles instead of inheriting a mini model', () => {
    expect(() => resolve({
      runtimeKind: 'app_studio',
      roleConfig: null,
      poolDefault: { provider: 'openai-chatgpt', model: 'gpt-5.4-mini' },
    })).toThrow(/not configured for this App Studio team/);

    expect(() => resolve({
      runtimeKind: 'app_studio',
      roleConfig: {
        role: 'backend', enabled: false, provider: 'p', model: 'm', tier: 'full',
      },
    })).toThrow(/disabled/);
  });

  it('rejects a malformed configured role and never falls through to Master', () => {
    expect(() => resolve({
      roleConfig: { role: 'backend', provider: '', model: '', tier: 'full' },
    })).toThrow(/incomplete configured runtime/);
    expect(() => resolve({
      roleConfig: { role: 'backend', provider: 'p', model: 'm', tier: 'unknown' },
    })).toThrow(/invalid tier/);
  });

  it('enforces allowed_models against the authoritative configured tuple', () => {
    expect(() => resolve({
      roleConfig: { role: 'backend', provider: 'p', model: 'premium', tier: 'full' },
      allowedModels: [{ provider: 'p', model: 'mini' }],
      poolDefault: { provider: 'p', model: 'mini' },
    })).toThrow(/p\/premium.*not in.*allowed_models/);
  });

  it('preserves the generic Company compatibility chain for unconfigured roles', () => {
    expect(resolve({
      requested: { provider: 'custom', model: 'explicit', tier: 'bootstrap' },
      masterRuntime: { provider: 'master', model: 'ignored' },
    })).toMatchObject({
      provider: 'custom', model: 'explicit', tier: 'bootstrap', resolutionSource: 'spawn_request',
    });

    expect(resolve({
      requested: {},
      allowedModels: [{ provider: 'pool', model: 'default', is_default: true }],
      poolDefault: { provider: 'pool', model: 'default', is_default: true },
    })).toMatchObject({ provider: 'pool', model: 'default', resolutionSource: 'allowed_models_default' });

    expect(resolve()).toMatchObject({
      provider: 'openai-chatgpt', model: 'gpt-5.6-terra', resolutionSource: 'master_runtime',
    });
  });

  it('rejects a partial provider/model request rather than making a mixed tuple', () => {
    expect(() => resolve({ requested: { provider: 'custom' } })).toThrow(/provider and model together/);
    expect(() => resolve({ requested: { model: 'model-only' } })).toThrow(/provider and model together/);
  });
});

describe('resolveEffectiveMasterRuntime', () => {
  it('keeps the persisted App Master authoritative over a mini request/default', () => {
    const result = resolveEffectiveMasterRuntime({
      runtimeKind: 'app_studio',
      configJson: JSON.stringify({
        runtime_kind: 'app_studio',
        master_provider: 'openai-chatgpt',
        master_model: 'gpt-5.6-terra',
        master_enabled: true,
        master_tier: 'full',
        master_temperature: 0.25,
        master_thinking: true,
        master_thinking_budget_tokens: 12000,
        master_reasoning_effort: 'xhigh',
        master_skills: ['backend-contracts', 'qa-checks', 'backend-contracts'],
        master_initial_tools: ['app_get_state', 'find_tools', 'app_get_state'],
        master_system_prompt_override: 'Coordinate through contracts first.',
        allowed_models: [
          { provider: 'openai-chatgpt', model: 'gpt-5.6-terra' },
          { provider: 'openai-chatgpt', model: 'gpt-5.4-mini', is_default: true },
        ],
      }),
      requested: { provider: 'openai-chatgpt', model: 'gpt-5.4-mini' },
    });

    expect(result).toMatchObject({
      provider: 'openai-chatgpt',
      model: 'gpt-5.6-terra',
      configuredProvider: 'openai-chatgpt',
      configuredModel: 'gpt-5.6-terra',
      reasoningEffort: 'xhigh',
      tier: 'navigate',
      temperature: 0.25,
      thinking: true,
      thinkingBudgetTokens: 12000,
      skills: ['backend-contracts', 'qa-checks'],
      initialTools: ['app_get_state', 'find_tools'],
      roleOverride: 'Coordinate through contracts first.',
      dispatchSource: 'app_studio',
      resolutionSource: 'role_assignment',
    });
  });

  it('fails closed for a missing or partial App Master tuple', () => {
    expect(() => resolveEffectiveMasterRuntime({
      runtimeKind: 'app_studio',
      configJson: JSON.stringify({ runtime_kind: 'app_studio' }),
    })).toThrow(/not configured for this App Studio team/);

    expect(() => resolveEffectiveMasterRuntime({
      runtimeKind: 'app_studio',
      configJson: JSON.stringify({
        runtime_kind: 'app_studio',
        master_provider: 'openai-chatgpt',
      }),
    })).toThrow(/master_provider and master_model together/);
  });

  it('fails closed for disabled or malformed persisted Master settings', () => {
    const base = {
      runtime_kind: 'app_studio',
      master_provider: 'p',
      master_model: 'primary',
      allowed_models: [{ provider: 'p', model: 'primary' }],
    };
    expect(() => resolveEffectiveMasterRuntime({
      runtimeKind: 'app_studio',
      configJson: JSON.stringify({ ...base, master_enabled: false }),
    })).toThrow(/disabled/);
    expect(() => resolveEffectiveMasterRuntime({
      runtimeKind: 'app_studio',
      configJson: JSON.stringify({ ...base, master_tier: 'root' }),
    })).toThrow(/master_tier/);
    expect(() => resolveEffectiveMasterRuntime({
      runtimeKind: 'app_studio',
      configJson: JSON.stringify({ ...base, master_thinking_budget_tokens: 0 }),
    })).toThrow(/positive integer/);
    expect(() => resolveEffectiveMasterRuntime({
      runtimeKind: 'app_studio',
      configJson: JSON.stringify({ ...base, master_skills: ['valid', ''] }),
    })).toThrow(/master_skills/);
    expect(() => resolveEffectiveMasterRuntime({
      runtimeKind: 'app_studio',
      configJson: JSON.stringify({ ...base, master_initial_tools: ['find_tools', ''] }),
    })).toThrow(/master_initial_tools/);
    expect(() => resolveEffectiveMasterRuntime({
      runtimeKind: 'app_studio',
      configJson: JSON.stringify({ ...base, master_system_prompt_override: 42 }),
    })).toThrow(/master_system_prompt_override/);
  });

  it('exposes only the explicit Master fallback chain', () => {
    const result = resolveEffectiveMasterRuntime({
      runtimeKind: 'app_studio',
      configJson: JSON.stringify({
        runtime_kind: 'app_studio',
        master_provider: 'p',
        master_model: 'primary',
        master_fallback_provider: 'p',
        master_fallback_model: 'secondary',
        allowed_models: [
          { provider: 'p', model: 'primary' },
          { provider: 'p', model: 'secondary' },
          { provider: 'p', model: 'mini', is_default: true },
        ],
      }),
    });
    expect(result.fallbackModels).toEqual([{ provider: 'p', model: 'secondary' }]);
  });

  it('retains the generic Company legacy fallback when no Master is configured', () => {
    expect(resolveEffectiveMasterRuntime({ configJson: '{}' })).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      resolutionSource: 'master_runtime',
    });
  });
});

describe('resolveRoleFallback', () => {
  it('uses only the configured role fallback chain and preserves its order', () => {
    const fallback = resolveRoleFallback({
      current: { provider: 'p', model: 'primary' },
      runtimeKind: 'app_studio',
      roleConfig: {
        role: 'backend', provider: 'p', model: 'primary', tier: 'full',
        fallbackModels: [
          { provider: 'p', model: 'secondary' },
          { provider: 'p', model: 'mini' },
        ],
      },
      allowedModels: [
        { provider: 'p', model: 'primary' },
        { provider: 'p', model: 'secondary' },
        { provider: 'p', model: 'mini' },
      ],
    });
    expect(fallback).toEqual({
      provider: 'p', model: 'secondary', reason: 'role_fallback_models',
    });

    expect(resolveRoleFallback({
      current: { provider: 'p', model: 'secondary' },
      runtimeKind: 'app_studio',
      roleConfig: {
        role: 'backend', provider: 'p', model: 'primary', tier: 'full',
        fallbackModels: [
          { provider: 'p', model: 'secondary' },
          { provider: 'p', model: 'mini' },
        ],
      },
      allowedModels: [
        { provider: 'p', model: 'primary' },
        { provider: 'p', model: 'secondary' },
        { provider: 'p', model: 'mini' },
      ],
    })).toEqual({ provider: 'p', model: 'mini', reason: 'role_fallback_models' });
  });

  it('never falls back an App Studio role through the global allowed pool', () => {
    expect(resolveRoleFallback({
      current: { provider: 'p', model: 'premium' },
      runtimeKind: 'app_studio',
      roleConfig: { role: 'backend', provider: 'p', model: 'premium', tier: 'full' },
      allowedModels: [{ provider: 'p', model: 'gpt-5.4-mini', is_default: true }],
    })).toBeNull();

    expect(resolveRoleFallback({
      current: { provider: 'p', model: 'premium' },
      runtimeKind: 'app_studio',
      roleConfig: null,
      allowedModels: [{ provider: 'p', model: 'gpt-5.4-mini', is_default: true }],
    })).toBeNull();
  });

  it('retains explicitly persisted allowed_models fallback for an unconfigured Company role', () => {
    expect(resolveRoleFallback({
      current: { provider: 'p', model: 'primary' },
      runtimeKind: 'company',
      roleConfig: null,
      allowedModels: [
        { provider: 'p', model: 'primary' },
        { provider: 'p', model: 'secondary', is_default: true },
      ],
    })).toEqual({
      provider: 'p', model: 'secondary', reason: 'allowed_models_fallback',
    });
  });
});
