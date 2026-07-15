import { describe, expect, it } from 'vitest';
import { inferToolErrorInfo } from '@mcp/code-agent/core/tool-error-info.js';

describe('inferToolErrorInfo', () => {
  it('classifies symbol lookup failures with a stable recovery contract', () => {
    expect(inferToolErrorInfo(
      'mcp__get_symbol_body',
      '[SYMBOL_NOT_FOUND] Symbol "buildAnnotations" not found.',
    )).toEqual({
      code: 'SYMBOL_NOT_FOUND',
      kind: 'not_found',
      retryable: false,
      suggestedAction: 'Use get_file_skeleton or search to verify the symbol name before retrying.',
    });
  });

  it('separates conflicts and operational failures', () => {
    expect(inferToolErrorInfo('create_file', 'File already exists')).toMatchObject({
      code: 'TOOL_CONFLICT', kind: 'conflict', retryable: false,
    });
    expect(inferToolErrorInfo('web_fetch', 'ECONNRESET')).toMatchObject({
      code: 'NETWORK_ERROR', kind: 'network', retryable: true,
    });
    expect(inferToolErrorInfo('run_command', 'timed out after 500 ms')).toMatchObject({
      code: 'TOOL_TIMEOUT', kind: 'timeout', retryable: true,
    });
  });
});
