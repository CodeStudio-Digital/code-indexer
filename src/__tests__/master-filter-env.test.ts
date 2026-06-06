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

describe('isMasterAllowed — env tools (read-only for master)', () => {
  // The master orchestrates: it may ANSWER a subordinate's env question
  // (read / list / validate) so it stops bouncing answerable questions to
  // the human — but it must NEVER mutate the shared store.
  it.each(['env_list', 'env_read', 'env_validate'])(
    'keeps read-only "%s" through the master filter',
    (toolName) => {
      expect(isMasterAllowed(fakeNative(toolName))).toBe(true);
    },
  );

  it.each(['env_set', 'env_delete'])(
    'strips mutating "%s" from the master',
    (toolName) => {
      expect(isMasterAllowed(fakeNative(toolName))).toBe(false);
    },
  );
});
