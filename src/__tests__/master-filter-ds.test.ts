import { describe, it, expect } from 'vitest';
import { isMasterAllowed } from '../core/coder/tools/company/master-filter.js';
import type { CoderTool } from '../core/coder/core/tool.js';

function fakeNative(name: string): CoderTool {
  return {
    name,
    description: '',
    parameters: { type: 'object', properties: {} },
    source: 'native',
    handler: async () => ({ ok: true, content: '' }),
  };
}

describe('isMasterAllowed — design-system tools', () => {
  // Regression guard: master never publishes / fails-explicitly when the
  // ds_* tools are stripped here. Adding 'ds_' to COMPANY_TOOL_PREFIXES
  // is what unblocks Phase 6 of the DS pipeline.
  it.each([
    'ds_get_session_info',
    'ds_record_component',
    'ds_validate_manifest',
    'ds_validate_stories',
    'ds_audit_package',
    'ds_set_version_status',
    'ds_publish_version',
  ])('keeps "%s" through the master filter', (toolName) => {
    expect(isMasterAllowed(fakeNative(toolName))).toBe(true);
  });

  it('keeps any future ds_* tool by prefix (the contract is the prefix, not the names)', () => {
    expect(isMasterAllowed(fakeNative('ds_future_tool_we_havent_thought_of'))).toBe(true);
  });

  it('still strips unrelated native tools so the filter remains effective', () => {
    // Sanity check — without these, the test would pass even if we
    // accidentally let everything through.
    expect(isMasterAllowed(fakeNative('read_file'))).toBe(false);
    expect(isMasterAllowed(fakeNative('write_file'))).toBe(false);
    expect(isMasterAllowed(fakeNative('run_command'))).toBe(false);
  });
});
