import { describe, it, expect } from 'vitest';
import { resolveAgentRunId, parseAgentPath, parseAgentPathTarget } from '@mcp/company/tools/path-resolution.js';

const ID_1 = '00000001-0000-4000-8000-000000000001';
const ID_7 = '00000007-0000-4000-8000-000000000007';
const ID_9 = '00000009-0000-4000-8000-000000000009';
const ID_12 = '00000012-0000-4000-8000-000000000012';
const ID_42 = '00000042-0000-4000-8000-000000000042';

describe('parseAgentPath', () => {
  it('extracts the trailing id from a well-formed path', () => {
    expect(parseAgentPath(`/root/master/qa-${ID_7}`)).toBe(ID_7);
    expect(parseAgentPath(`/root/master/frontend-${ID_12}`)).toBe(ID_12);
  });

  it('handles roles that contain hyphens', () => {
    expect(parseAgentPath(`/root/master/qa-frontend-${ID_42}`)).toBe(ID_42);
    expect(parseAgentPath(`/root/master/code-reviewer-${ID_9}`)).toBe(ID_9);
  });

  it('returns null for /root and /root/master', () => {
    expect(parseAgentPath('/root')).toBeNull();
    expect(parseAgentPath('/root/master')).toBeNull();
  });

  it('returns null for paths missing the master segment', () => {
    expect(parseAgentPath(`/root/qa-${ID_7}`)).toBeNull();
  });

  it('returns null when there is no trailing canonical UUID', () => {
    expect(parseAgentPath('/root/master/qa')).toBeNull();
    expect(parseAgentPath('/root/master/qa-')).toBeNull();
    expect(parseAgentPath('/root/master/qa-abc')).toBeNull();
  });
});

describe('parseAgentPathTarget', () => {
  it('returns master kind for /root/master', () => {
    expect(parseAgentPathTarget('/root/master')).toEqual({ kind: 'master', agentRunId: null });
  });

  it('returns subordinate kind with id for /root/master/<role>-<id>', () => {
    expect(parseAgentPathTarget(`/root/master/qa-${ID_7}`)).toEqual({ kind: 'subordinate', agentRunId: ID_7 });
    expect(parseAgentPathTarget(`/root/master/qa-frontend-${ID_12}`)).toEqual({ kind: 'subordinate', agentRunId: ID_12 });
  });

  it('returns null for /root and unrelated shapes', () => {
    expect(parseAgentPathTarget('/root')).toBeNull();
    expect(parseAgentPathTarget(`/root/qa-${ID_1}`)).toBeNull();
    expect(parseAgentPathTarget('/root/master/qa')).toBeNull();
    expect(parseAgentPathTarget('garbage')).toBeNull();
  });
});

describe('resolveAgentRunId', () => {
  it('prefers explicit agent_run_id when present', () => {
    const r = resolveAgentRunId({ agent_run_id: ID_42, path: `/root/master/qa-${ID_7}` });
    expect(r).toEqual({ ok: true, agentRunId: ID_42 });
  });

  it('falls back to path when agent_run_id is missing', () => {
    const r = resolveAgentRunId({ path: `/root/master/qa-${ID_7}` });
    expect(r).toEqual({ ok: true, agentRunId: ID_7 });
  });

  it('errors with useful detail when both are missing', () => {
    const r = resolveAgentRunId({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('agent_run_id');
  });

  it('errors when path is malformed and id is absent', () => {
    const r = resolveAgentRunId({ path: 'bogus' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('not a recognized agent path');
  });

  it('treats a malformed agent_run_id as missing and falls through to path', () => {
    const r = resolveAgentRunId({ agent_run_id: 'seven', path: `/root/master/qa-${ID_7}` });
    expect(r).toEqual({ ok: true, agentRunId: ID_7 });
  });

  it('errors when both agent_run_id is malformed and path is missing', () => {
    const r = resolveAgentRunId({ agent_run_id: 'seven' });
    expect(r.ok).toBe(false);
  });
});
