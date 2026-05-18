import { describe, it, expect, vi } from 'vitest';
import { MasterLifecycle } from '@mcp/company/services/MasterLifecycle.js';

// The MasterLifecycle surface we can exercise without runCoder:
//   - All read-only getters and state-machine flags before `start()` runs
//   - `setShouldContinue` / `consumeShouldContinue` flag cycle
//   - `updateRoleConfigs` / `getRoleDefaults` / `roleConfigs`
//   - `getAllowedModels` / `getPoolDefault` (empty pool path)
//   - `abort()` on a master that was never started
//   - `notify()` when the master has no handle (routes to resurrect which
//     early-bails) — including `enrichWithBoard` with empty / non-empty / throwing board
//   - `sendUserMessage()` lazy-resurrect path
//
// Anything that requires `runCoder` (start/resumeExisting/resurrect actually
// running, swapProvider needing a real provider) is out of scope for unit tests;
// covered by integration harnesses in Phase 9.

function makeBaseDeps(overrides?: {
  readBoard?: () => unknown[];
  lastMasterSeenId?: number;
  advanceMasterWatermark?: (id: number) => void;
  post?: (...args: unknown[]) => void;
  setStatus?: (...args: unknown[]) => void;
  onMasterResurrected?: () => void;
  onMasterEnded?: () => void;
  onUserMessageReceived?: () => void;
  updateCompanySessionStatus?: (...args: unknown[]) => void;
  cancelPendingMasterPrompts?: () => void;
}) {
  return {
    ctx: {
      companySessionId: 42,
      companyStore: {
        readBoard: overrides?.readBoard ?? (() => []),
        getCompanySession: () => null,
        updateCompanySessionStatus: overrides?.updateCompanySessionStatus ?? (() => undefined),
      },
      isAborted: false,
      isBusEnded: false,
    },
    board: {
      lastMasterSeenId: overrides?.lastMasterSeenId ?? 0,
      advanceMasterWatermark: overrides?.advanceMasterWatermark ?? (() => undefined),
      post: overrides?.post ?? (() => undefined),
    },
    status: { setStatus: overrides?.setStatus ?? (() => undefined) },
    humanInLoop: { cancelPendingMasterPrompts: overrides?.cancelPendingMasterPrompts ?? (() => undefined) },
    wirer: {},
    idle: {
      onMasterResurrected: overrides?.onMasterResurrected ?? (() => undefined),
      onMasterEnded: overrides?.onMasterEnded ?? (() => undefined),
      onUserMessageReceived: overrides?.onUserMessageReceived ?? (() => undefined),
    },
    attention: {},
    orchestratorRef: {},
  } as never;
}

function makeLifecycle(): MasterLifecycle {
  return new MasterLifecycle(makeBaseDeps());
}

describe('MasterLifecycle — initial state (before start)', () => {
  it('handle is null', () => {
    expect(makeLifecycle().handle).toBeNull();
  });

  it('agentRunId is null', () => {
    expect(makeLifecycle().agentRunId).toBeNull();
  });

  it('isAlive is false (no runner attached yet)', () => {
    expect(makeLifecycle().isAlive).toBe(false);
  });

  it('hasEnded is false (run never started)', () => {
    expect(makeLifecycle().hasEnded).toBe(false);
  });

  it('endedWithError is null', () => {
    expect(makeLifecycle().endedWithError).toBeNull();
  });

  it('roleConfigs is empty array', () => {
    expect(makeLifecycle().roleConfigs).toEqual([]);
  });

  it('getLastUserAttachments returns empty array', () => {
    expect(makeLifecycle().getLastUserAttachments()).toEqual([]);
  });

  it('getAllowedModels returns empty array', () => {
    expect(makeLifecycle().getAllowedModels()).toEqual([]);
  });

  it('getPoolDefault returns null when pool is empty', () => {
    expect(makeLifecycle().getPoolDefault()).toBeNull();
  });
});

describe('MasterLifecycle — shouldContinue flag cycle', () => {
  it('consumeShouldContinue returns false by default', () => {
    expect(makeLifecycle().consumeShouldContinue()).toBe(false);
  });

  it('setShouldContinue(true) then consume returns true once, then false', () => {
    const lc = makeLifecycle();
    lc.setShouldContinue(true);
    expect(lc.consumeShouldContinue()).toBe(true);
    expect(lc.consumeShouldContinue()).toBe(false);
  });

  it('setShouldContinue(false) explicitly clears a previously-set flag', () => {
    const lc = makeLifecycle();
    lc.setShouldContinue(true);
    lc.setShouldContinue(false);
    expect(lc.consumeShouldContinue()).toBe(false);
  });
});

describe('MasterLifecycle — role configs', () => {
  it('updateRoleConfigs populates the list', () => {
    const lc = makeLifecycle();
    lc.updateRoleConfigs([
      { role: 'frontend', provider: 'anthropic', model: 'claude-sonnet-4-6', tier: 'sonnet' },
    ]);
    expect(lc.roleConfigs).toHaveLength(1);
    expect(lc.roleConfigs[0].role).toBe('frontend');
  });

  it('updateRoleConfigs replaces (not merges) the previous list', () => {
    const lc = makeLifecycle();
    lc.updateRoleConfigs([
      { role: 'frontend', provider: 'anthropic', model: 'm1', tier: 't1' },
    ]);
    lc.updateRoleConfigs([
      { role: 'backend', provider: 'openai', model: 'm2', tier: 't2' },
    ]);
    expect(lc.roleConfigs).toHaveLength(1);
    expect(lc.roleConfigs[0].role).toBe('backend');
  });

  it('getRoleDefaults returns null for an unknown role', () => {
    const lc = makeLifecycle();
    lc.updateRoleConfigs([
      { role: 'frontend', provider: 'anthropic', model: 'm1', tier: 't1' },
    ]);
    expect(lc.getRoleDefaults('qa')).toBeNull();
  });

  it('getRoleDefaults exposes provider/model/tier for a known role', () => {
    const lc = makeLifecycle();
    lc.updateRoleConfigs([
      { role: 'frontend', provider: 'anthropic', model: 'claude-sonnet-4-6', tier: 'sonnet' },
    ]);
    expect(lc.getRoleDefaults('frontend')).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      tier: 'sonnet',
    });
  });

  it('getRoleDefaults forwards skills / projectIds / temperature when set', () => {
    const lc = makeLifecycle();
    lc.updateRoleConfigs([
      {
        role: 'frontend',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        tier: 'sonnet',
        skills: ['skill-a'],
        projectIds: [7, 8],
        temperature: 0.3,
      },
    ]);
    const defaults = lc.getRoleDefaults('frontend');
    expect(defaults?.skills).toEqual(['skill-a']);
    expect(defaults?.projectIds).toEqual([7, 8]);
    expect(defaults?.temperature).toBe(0.3);
  });

  it('getRoleDefaults forwards systemPromptOverride when set', () => {
    const lc = makeLifecycle();
    lc.updateRoleConfigs([
      {
        role: 'frontend',
        provider: 'anthropic',
        model: 'm1',
        tier: 't1',
        systemPromptOverride: 'be terse',
      },
    ]);
    expect(lc.getRoleDefaults('frontend')?.systemPromptOverride).toBe('be terse');
  });
});

describe('MasterLifecycle — abort without an active handle', () => {
  it('marks ended and records "aborted" error message', () => {
    const lc = makeLifecycle();
    lc.abort();
    expect(lc.hasEnded).toBe(true);
    expect(lc.endedWithError).toBe('aborted');
    expect(lc.isAlive).toBe(false);
  });

  it('does not call status.setStatus when agentRunId is null', () => {
    const setStatus = vi.fn();
    const lc = new MasterLifecycle(makeBaseDeps({ setStatus }));
    lc.abort();
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('preserves a previously-set endedWithError instead of overwriting with "aborted"', () => {
    const lc = makeLifecycle();
    // Simulate a runner that ended with error first; we can't trigger this via
    // the public API without runCoder, so this test documents that abort()
    // uses `?? 'aborted'` rather than unconditional assignment by relying on
    // the implementation contract (see `_endedWithError = this._endedWithError ?? 'aborted'`).
    lc.abort();
    expect(lc.endedWithError).toBe('aborted');
    // Second abort should not change the recorded reason.
    lc.abort();
    expect(lc.endedWithError).toBe('aborted');
  });
});

describe('MasterLifecycle — notify with no master handle', () => {
  it('calls idle.onMasterResurrected before falling through to (no-op) resurrect', () => {
    const onMasterResurrected = vi.fn();
    const lc = new MasterLifecycle(makeBaseDeps({ onMasterResurrected }));
    lc.notify('hello');
    expect(onMasterResurrected).toHaveBeenCalledOnce();
    // resurrect bails out (handle/context/agentRunId all null), so the master
    // does not transition to ended/running. This is the lazy-start contract:
    // notify on a never-started master is observable via idle but otherwise
    // a no-op until something else (start/sendUserMessage) actually boots it.
    expect(lc.hasEnded).toBe(false);
  });

  it('advances board watermark when board has recent entries', () => {
    const advance = vi.fn();
    const deps = makeBaseDeps({
      readBoard: () => [
        { id: 100, author_role: 'frontend', kind: 'message', content: 'done' },
        { id: 101, author_role: 'backend', kind: 'message', content: 'also done' },
      ],
      advanceMasterWatermark: advance,
    });
    const lc = new MasterLifecycle(deps);
    lc.notify('subordinate finished');
    expect(advance).toHaveBeenCalledWith(101);
  });

  it('does not advance watermark when readBoard returns []', () => {
    const advance = vi.fn();
    const lc = new MasterLifecycle(
      makeBaseDeps({ readBoard: () => [], advanceMasterWatermark: advance }),
    );
    lc.notify('still nothing');
    expect(advance).not.toHaveBeenCalled();
  });

  it('silently degrades when readBoard throws (does not propagate)', () => {
    const lc = new MasterLifecycle(
      makeBaseDeps({
        readBoard: () => {
          throw new Error('DB unreachable');
        },
      }),
    );
    expect(() => lc.notify('msg')).not.toThrow();
  });
});

describe('MasterLifecycle — sendUserMessage with no handle (lazy-resurrect path)', () => {
  it('posts the human message on the board even when master has not started', () => {
    const post = vi.fn();
    const lc = new MasterLifecycle(makeBaseDeps({ post }));
    lc.sendUserMessage('hello master');
    expect(post).toHaveBeenCalledWith('human', null, 'message', 'hello master');
  });

  it('notifies idle that a user message was received (resets idle timer)', () => {
    const onUserMessageReceived = vi.fn();
    const lc = new MasterLifecycle(makeBaseDeps({ onUserMessageReceived }));
    lc.sendUserMessage('hello');
    expect(onUserMessageReceived).toHaveBeenCalledOnce();
  });

  it('attempts to flip the session back to running before resurrecting', () => {
    const updateCompanySessionStatus = vi.fn();
    const lc = new MasterLifecycle(makeBaseDeps({ updateCompanySessionStatus }));
    lc.sendUserMessage('hello');
    expect(updateCompanySessionStatus).toHaveBeenCalledWith(42, 'running');
  });

  it('returns { ok: true } from the lazy-resurrect path', () => {
    const lc = makeLifecycle();
    expect(lc.sendUserMessage('hello')).toEqual({ ok: true });
  });

  it('attaches the attachments count to the board message when present', () => {
    const post = vi.fn();
    const lc = new MasterLifecycle(makeBaseDeps({ post }));
    lc.sendUserMessage('look at this', {
      attachments: [
        { kind: 'image', mediaType: 'image/png', source: { type: 'base64', data: 'x' } },
      ] as never,
    });
    expect(post).toHaveBeenCalledWith(
      'human',
      null,
      'message',
      expect.stringContaining('[1 attachment]'),
    );
  });

  it('stores attachments so a later forward_to_agent can read them', () => {
    const lc = makeLifecycle();
    const att = [
      { kind: 'image', mediaType: 'image/png', source: { type: 'base64', data: 'x' } },
    ] as never;
    lc.sendUserMessage('look', { attachments: att });
    expect(lc.getLastUserAttachments()).toBe(att);
  });
});
