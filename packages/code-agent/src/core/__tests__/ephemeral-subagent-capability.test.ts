import { describe, expect, it } from 'vitest';
import { shouldEnableEphemeralSubagents } from '../ephemeral-subagent-capability.js';

const appCapabilities = {
  runtimeKind: 'app_studio' as const,
  appStudioSessionId: '00000000-0000-4000-8000-000000000007',
  promptProfile: 'app_studio' as const,
  toolProfile: 'app_studio' as const,
  autonomyPolicy: 'controlled_app_work' as const,
  workSource: 'app_workflow' as const,
  allowAppTools: true,
  allowCompanyKanban: false,
  allowCompanyScheduler: false,
  allowAppScheduler: true,
  allowFreeSubordinateSpawn: false,
};

describe('shouldEnableEphemeralSubagents', () => {
  it('keeps the existing solo and generic Company specialist paths', () => {
    expect(shouldEnableEphemeralSubagents(undefined, false)).toBe(true);
    expect(shouldEnableEphemeralSubagents({
      isMaster: false,
      runtimeKind: 'company',
    }, false)).toBe(true);
  });

  it('removes spawn_agent companions from App specialists', () => {
    expect(shouldEnableEphemeralSubagents({
      isMaster: false,
      runtimeKind: 'app_studio',
      capabilities: appCapabilities,
    }, false)).toBe(false);
  });

  it('fails closed for an older App context without derived capabilities', () => {
    expect(shouldEnableEphemeralSubagents({
      isMaster: false,
      runtimeKind: 'app_studio',
    }, false)).toBe(false);
  });

  it('never enables the ephemeral path for a Company Master or global kill switch', () => {
    expect(shouldEnableEphemeralSubagents({ isMaster: true, runtimeKind: 'company' }, false)).toBe(false);
    expect(shouldEnableEphemeralSubagents(undefined, true)).toBe(false);
  });
});
