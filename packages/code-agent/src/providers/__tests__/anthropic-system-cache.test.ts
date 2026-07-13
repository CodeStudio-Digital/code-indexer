import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../../core/system-prompt.js';
import { buildAnthropicSystemBlocks } from '../anthropic.js';

describe('Anthropic system prompt cache boundary', () => {
  it('caches the stable prefix and leaves the dynamic suffix uncached', () => {
    const blocks = buildAnthropicSystemBlocks(
      [{ type: 'text', text: 'oauth identity' }],
      `stable prompt\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\ndynamic repo map`,
    );

    expect(blocks).toEqual([
      { type: 'text', text: 'oauth identity' },
      { type: 'text', text: 'stable prompt', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'dynamic repo map' },
    ]);
  });

  it('keeps the legacy last-block breakpoint when no boundary exists', () => {
    expect(buildAnthropicSystemBlocks(undefined, 'whole prompt')).toEqual([
      { type: 'text', text: 'whole prompt', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('does not leak the internal marker to Anthropic', () => {
    const blocks = buildAnthropicSystemBlocks(undefined, `a${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}b`);
    expect(blocks.map((block) => block.text).join('')).toBe('ab');
  });

  it('never caches a dynamic-only tail', () => {
    expect(buildAnthropicSystemBlocks(
      [{ type: 'text', text: 'oauth identity' }],
      `${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}dynamic`,
    )).toEqual([
      { type: 'text', text: 'oauth identity', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'dynamic' },
    ]);
    expect(buildAnthropicSystemBlocks(undefined, `${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}dynamic`)).toEqual([
      { type: 'text', text: 'dynamic' },
    ]);
  });
});
