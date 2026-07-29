/**
 * Tests for resolveAndRunMaster — the resume-or-start decision shared by
 * /start and /resume.
 *
 * Regression: a session that ALREADY has a master run
 * must RESUME it (reuse the coder-session, keep context), never spawn a fresh
 * master. Only a session with no master run cold-starts.
 */
import { describe, expect, it, vi } from 'vitest';
import { resolveAndRunMaster } from '../master-resolve.js';

const MASTER_SESSION_ID = 'd0000000-0000-4000-8000-000000000001';

function makeOrch() {
  return {
    startMaster: vi.fn(async (_o: unknown) => ({
      masterSessionId: MASTER_SESSION_ID,
      indexStatus: null,
    })),
    resumeExistingMaster: vi.fn(async (_o: unknown) => ({
      masterSessionId: MASTER_SESSION_ID,
      indexStatus: null,
    })),
  };
}
type Orch = Parameters<typeof resolveAndRunMaster>[0];

const opts = {
  userMessage: 'siga para os próximos',
  provider: 'openai-chatgpt',
  model: 'gpt-5.5',
  maxTurns: 100,
  roleConfigs: [],
  attachments: undefined,
};

describe('resolveAndRunMaster', () => {
  it('RESUMES when a master run already exists (reuse coder-session, keep context)', async () => {
    const orch = makeOrch();
    await resolveAndRunMaster(orch as unknown as Orch, true, opts);
    expect(orch.resumeExistingMaster).toHaveBeenCalledTimes(1);
    expect(orch.startMaster).not.toHaveBeenCalled();
  });

  it('cold-STARTS when no master run exists (brand-new sub-session)', async () => {
    const orch = makeOrch();
    await resolveAndRunMaster(orch as unknown as Orch, false, opts);
    expect(orch.startMaster).toHaveBeenCalledTimes(1);
    expect(orch.resumeExistingMaster).not.toHaveBeenCalled();
  });

  it('resume path forwards the authoritative provider/model without creating a new run', async () => {
    const orch = makeOrch();
    await resolveAndRunMaster(orch as unknown as Orch, true, opts);
    expect(orch.resumeExistingMaster).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: 'siga para os próximos',
        provider: 'openai-chatgpt',
        model: 'gpt-5.5',
      }),
    );
  });
});
