import { describe, it, expect } from 'vitest';
import { isMasterAllowed } from '@mcp/company/tools/master-filter.js';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';

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
  // The company DS pipeline was retired (mig 132): DS Studio runs as a
  // single coder session, so the company master never hosts ds_* tools.
  // The 'ds_' prefix was removed from COMPANY_TOOL_PREFIXES — lock that.
  it.each([
    'ds_get_session_info',
    'ds_record_component',
    'ds_list_components',
    'ds_audit_package',
    'ds_set_version_status',
    'ds_publish_version',
  ])('strips "%s" through the master filter', (toolName) => {
    expect(isMasterAllowed(fakeNative(toolName))).toBe(false);
  });

  it('still keeps company orchestration tools so the filter remains effective', () => {
    expect(isMasterAllowed(fakeNative('post_to_board'))).toBe(true);
    expect(isMasterAllowed(fakeNative('kanban_create_card'))).toBe(true);
  });

  it('still strips unrelated native tools', () => {
    expect(isMasterAllowed(fakeNative('read_file'))).toBe(false);
    expect(isMasterAllowed(fakeNative('write_file'))).toBe(false);
    expect(isMasterAllowed(fakeNative('run_command'))).toBe(false);
  });
});
