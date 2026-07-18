import { describe, expect, it } from 'vitest';
import { resolveRegisteredToolOutputPolicy, resolveToolOutputPolicy } from '../tool-output-policy.js';

describe('tool output policy', () => {
  it('protects authoritative instructions and plans from the generic reducer', () => {
    for (const name of ['read_plan', 'get_skill_content', 'invoke_skill', 'app_get_plan', 'mcp__rag_read_doc']) {
      expect(resolveToolOutputPolicy(name)).toMatchObject({
        mode: 'authoritative',
        reducer: 'none',
        recovery: 'output_store',
        capStrategy: 'contiguous',
      });
    }
  });

  it('treats recovery pages as cursor-owned contiguous output', () => {
    expect(resolveToolOutputPolicy('get_tool_output')).toMatchObject({
      mode: 'page',
      reducer: 'none',
      recovery: 'cursor',
      capStrategy: 'contiguous',
    });
  });

  it('prefers a dynamic/plugin declaration over name inference', () => {
    const resolved = resolveRegisteredToolOutputPolicy('plugin__acme__report', {
      outputPolicy: {
        mode: 'rows',
        reducer: 'smart',
        recovery: 'cursor',
        maxInlineChars: 8000.9,
      },
    });
    expect(resolved).toMatchObject({
      mode: 'rows',
      recovery: 'cursor',
      maxInlineChars: 8000,
      capStrategy: 'contiguous',
    });
  });

  it('keeps legacy host-preserved dynamic tools authoritative', () => {
    const resolved = resolveRegisteredToolOutputPolicy(
      'dynamic_extension_result',
      undefined,
      true,
    );

    expect(resolved).toMatchObject({
      mode: 'authoritative',
      reducer: 'none',
      recovery: 'output_store',
      preserveOnError: true,
      capStrategy: 'contiguous',
    });
  });
});
