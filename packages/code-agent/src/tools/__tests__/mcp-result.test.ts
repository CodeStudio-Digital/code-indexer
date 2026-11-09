import { expect, it } from 'vitest';
import { mcpResultToToolResult } from '../mcp-result.js';

it('preserves canonical data, attachments and truncation evidence even on a failed call', () => {
  const result = mcpResultToToolResult({ isError: true, structuredContent: { partial: [1] },
    content: [{ type: 'text', text: 'partial failure' }, { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }, { type: 'unknown' }],
    _meta: { sourceTruncations: [{ technique: 'remote-page', inputSize: 11, outputSize: 1, unit: 'rows', recoverable: true, outputId: 'remote-only' }] },
  }, 'search');
  expect(result).toMatchObject({ isError: true, structuredData: { partial: [1] }, extraUserBlocks: [{ type: 'image', base64: 'aW1hZ2U=' }] });
  expect(result.sourceTruncations).toMatchObject([{ technique: 'remote-page', recoverable: false }, { technique: 'unsupported-mcp-block', inputSize: 3, outputSize: 2 }]);
  expect(result.content).toContain('unsupported content');
});
