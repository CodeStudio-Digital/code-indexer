import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setSessionActiveSkills: vi.fn(async () => undefined),
}));

import { configureMasterSkills } from '../configure-skills.js';
import { appendMasterRoleInstructions } from '../prompt-builder.js';

describe('persisted App Master role config', () => {
  const coderSessionId = '137d4f95-f0b0-4de9-a40c-9f6eff7e93d0';
  const sessionStore = {
    setSessionActiveSkills: mocks.setSessionActiveSkills,
  };

  beforeEach(() => vi.clearAllMocks());

  it('injects the Master prompt into the real system block', () => {
    expect(appendMasterRoleInstructions('base company prompt', '  contracts first  '))
      .toBe('base company prompt\n\n## MASTER ROLE INSTRUCTIONS\n\ncontracts first');
    expect(appendMasterRoleInstructions('base company prompt', '   '))
      .toBe('base company prompt');
  });

  it('applies explicit App Master skills even without a synthetic master roster role', async () => {
    await configureMasterSkills({
      roleConfigs: [{ role: 'backend', provider: 'p', model: 'm', tier: 'full' }],
      configuredStack: null,
      coderSessionId,
      sessionStore,
      masterSkills: ['qa-checks'],
    });

    expect(mocks.setSessionActiveSkills).toHaveBeenCalledWith(
      coderSessionId,
      ['qa-checks'],
    );
  });

  it('treats an explicit empty list as clearing prior Master skill selection', async () => {
    await configureMasterSkills({
      roleConfigs: [],
      configuredStack: null,
      coderSessionId,
      sessionStore,
      masterSkills: [],
    });

    expect(mocks.setSessionActiveSkills).toHaveBeenCalledWith(
      coderSessionId,
      [],
    );
  });
});
