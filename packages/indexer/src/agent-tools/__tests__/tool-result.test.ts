import { describe, expect, it } from 'vitest';
import { normalizeMcpToolResult, mcpToolResultFields } from '../tool.js';

describe('normalizeMcpToolResult', () => {
  it('keeps owner uncertainty in the shared HTTP and stdio envelope', () => {
    expect(mcpToolResultFields({ text: 'ACK lost', effectOutcome: 'unknown' })).toEqual({
      isError: true, _meta: { effectOutcome: 'unknown' },
    });
    expect(mcpToolResultFields({ text: 'complete' })).toEqual({});
  });
  it('wraps legacy string results in the structured envelope', () => {
    expect(normalizeMcpToolResult('plain text')).toEqual({ text: 'plain text' });
  });

  it('preserves structured text and source omission metadata', () => {
    const result = {
      text: 'lines 1-40',
      sourceTruncations: [{
        technique: 'mcp-read-file-line-window',
        inputSize: 100,
        outputSize: 40,
        unit: 'lines' as const,
        recoverable: true,
      }],
    };

    expect(normalizeMcpToolResult(result)).toBe(result);
  });
});
