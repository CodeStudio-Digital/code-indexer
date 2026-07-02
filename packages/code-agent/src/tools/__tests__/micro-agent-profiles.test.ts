import { describe, expect, it } from 'vitest';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import {
  MICRO_AGENT_PROFILES,
  microAgentProfileForTaskKind,
  resolveMicroAgentProfile,
} from '@mcp/code-agent/tools/micro-agent-profiles.js';

const tool = (
  name: string,
  source: CoderTool['source'] = 'native',
  mutates?: boolean,
) => ({ name, source, mutates }) as CoderTool;

function allowed(allowlist: typeof MICRO_AGENT_PROFILES.verify.allowlist, coderTool: CoderTool): boolean {
  if (allowlist === null) return true;
  if (typeof allowlist === 'function') return allowlist(coderTool);
  return allowlist.has(coderTool.name);
}

describe('micro-agent profiles', () => {
  it('resolves friendly aliases to canonical profiles', () => {
    expect(resolveMicroAgentProfile('investigator')?.id).toBe('explore');
    expect(resolveMicroAgentProfile('readonly')?.id).toBe('explore');
    expect(resolveMicroAgentProfile('implementer')?.id).toBe('implement');
    expect(resolveMicroAgentProfile('verifier')?.id).toBe('verify');
    expect(resolveMicroAgentProfile('reviewer')?.id).toBe('review');
  });

  it('keeps verify read/shell capable but non-mutating', () => {
    const verify = MICRO_AGENT_PROFILES.verify;
    expect(allowed(verify.allowlist, tool('run_command'))).toBe(true);
    expect(allowed(verify.allowlist, tool('get_diagnostics'))).toBe(true);
    expect(allowed(verify.allowlist, tool('write_file'))).toBe(false);
    expect(allowed(verify.allowlist, tool('edit_file'))).toBe(false);
  });

  it('uses stricter write scope for implement profiles', () => {
    expect(MICRO_AGENT_PROFILES.implement.pathScopeMode).toBe('enforce-writes');
    expect(MICRO_AGENT_PROFILES.explore.pathScopeMode).toBe('warn');
    expect(MICRO_AGENT_PROFILES.verify.pathScopeMode).toBe('warn');
    expect(MICRO_AGENT_PROFILES.review.pathScopeMode).toBe('warn');
  });

  it('maps executable task kinds onto the same profile registry', () => {
    expect(microAgentProfileForTaskKind('investigate').id).toBe('explore');
    expect(microAgentProfileForTaskKind('verify').id).toBe('verify');
    expect(microAgentProfileForTaskKind('implement').id).toBe('implement');
    expect(microAgentProfileForTaskKind(undefined).id).toBe('implement');
  });
});
