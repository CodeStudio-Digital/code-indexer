import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveActiveSkills: vi.fn(() => [
    { id: 'backend-contracts' },
    { id: 'qa-checks' },
  ]),
  setSessionSkillEnabled: vi.fn(),
  close: vi.fn(),
}));

vi.mock('@mcp/store/skill-store.js', () => ({
  SkillStore: class {
    resolveActiveSkills = mocks.resolveActiveSkills;
    setSessionSkillEnabled = mocks.setSessionSkillEnabled;
    close = mocks.close;
  },
}));
vi.mock('@mcp/shared/utils/config.js', () => ({
  loadConfig: () => ({ dbPath: ':memory:' }),
}));

import { configureMasterSkills } from '../configure-skills.js';
import { appendMasterRoleInstructions } from '../prompt-builder.js';

describe('persisted App Master role config', () => {
  beforeEach(() => vi.clearAllMocks());

  it('injects the Master prompt into the real system block', () => {
    expect(appendMasterRoleInstructions('base company prompt', '  contracts first  '))
      .toBe('base company prompt\n\n## MASTER ROLE INSTRUCTIONS\n\ncontracts first');
    expect(appendMasterRoleInstructions('base company prompt', '   '))
      .toBe('base company prompt');
  });

  it('applies explicit App Master skills even without a synthetic master roster role', () => {
    configureMasterSkills({
      roleConfigs: [{ role: 'backend', provider: 'p', model: 'm', tier: 'full' }],
      configuredStack: null,
      coderSessionId: 77,
      primaryProjectId: 8,
      masterSkills: ['qa-checks'],
    });

    expect(mocks.setSessionSkillEnabled.mock.calls).toEqual([
      [77, 'backend-contracts', false],
      [77, 'qa-checks', true],
    ]);
  });

  it('treats an explicit empty list as disabling prior Master skill overrides', () => {
    configureMasterSkills({
      roleConfigs: [],
      configuredStack: null,
      coderSessionId: 77,
      primaryProjectId: 8,
      masterSkills: [],
    });

    expect(mocks.setSessionSkillEnabled.mock.calls).toEqual([
      [77, 'backend-contracts', false],
      [77, 'qa-checks', false],
    ]);
  });
});
