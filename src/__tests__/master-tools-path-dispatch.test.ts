import { describe, it, expect } from 'vitest';
import { resolveAgentRunId, parseAgentPath, parseAgentPathTarget } from '../core/coder/tools/company/path-resolution.js';

describe('parseAgentPath', () => {
  it('extracts the trailing id from a well-formed path', () => {
    expect(parseAgentPath('/root/master/qa-7')).toBe(7);
    expect(parseAgentPath('/root/master/frontend-12')).toBe(12);
  });

  it('handles roles that contain hyphens', () => {
    expect(parseAgentPath('/root/master/qa-frontend-42')).toBe(42);
    expect(parseAgentPath('/root/master/code-reviewer-9')).toBe(9);
  });

  it('returns null for /root and /root/master', () => {
    expect(parseAgentPath('/root')).toBeNull();
    expect(parseAgentPath('/root/master')).toBeNull();
  });

  it('returns null for paths missing the master segment', () => {
    expect(parseAgentPath('/root/qa-7')).toBeNull();
  });

  it('returns null when there is no trailing -<digits>', () => {
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
    expect(parseAgentPathTarget('/root/master/qa-7')).toEqual({ kind: 'subordinate', agentRunId: 7 });
    expect(parseAgentPathTarget('/root/master/qa-frontend-12')).toEqual({ kind: 'subordinate', agentRunId: 12 });
  });

  it('returns null for /root and unrelated shapes', () => {
    expect(parseAgentPathTarget('/root')).toBeNull();
    expect(parseAgentPathTarget('/root/qa-1')).toBeNull();
    expect(parseAgentPathTarget('/root/master/qa')).toBeNull();
    expect(parseAgentPathTarget('garbage')).toBeNull();
  });
});

describe('resolveAgentRunId', () => {
  it('prefers explicit agent_run_id when present', () => {
    const r = resolveAgentRunId({ agent_run_id: 42, path: '/root/master/qa-7' });
    expect(r).toEqual({ ok: true, agentRunId: 42 });
  });

  it('falls back to path when agent_run_id is missing', () => {
    const r = resolveAgentRunId({ path: '/root/master/qa-7' });
    expect(r).toEqual({ ok: true, agentRunId: 7 });
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

  it('treats non-numeric agent_run_id as missing and falls through to path', () => {
    const r = resolveAgentRunId({ agent_run_id: 'seven' as unknown as number, path: '/root/master/qa-7' });
    expect(r).toEqual({ ok: true, agentRunId: 7 });
  });

  it('errors when both agent_run_id is non-numeric and path is missing', () => {
    const r = resolveAgentRunId({ agent_run_id: NaN });
    expect(r.ok).toBe(false);
  });
});
