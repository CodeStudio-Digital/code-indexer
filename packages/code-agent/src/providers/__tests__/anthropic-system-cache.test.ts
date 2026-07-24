import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../../core/system-prompt.js';
import {
  applyAnthropicMessageCacheBreakpoint,
  buildAnthropicSystemBlocks,
} from '../anthropic.js';

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

  it('applies the extended TTL to the stable system boundary', () => {
    expect(buildAnthropicSystemBlocks(undefined, 'whole prompt', '1h')).toEqual([{
      type: 'text',
      text: 'whole prompt',
      cache_control: { type: 'ephemeral', ttl: '1h' },
    }]);
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

describe('Anthropic conversation cache boundary', () => {
  it('moves the one-hour breakpoint to the newest message on each turn', () => {
    const firstTurn = applyAnthropicMessageCacheBreakpoint([
      { role: 'user', content: [{ type: 'text', text: 'first prompt' }] },
    ], '1h');

    expect(firstTurn).toEqual([{
      role: 'user',
      content: [{
        type: 'text',
        text: 'first prompt',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      }],
    }]);

    const secondTurn = applyAnthropicMessageCacheBreakpoint([
      { role: 'user', content: [{ type: 'text', text: 'first prompt' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'second prompt' }] },
    ], '1h');

    expect(secondTurn).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'first prompt' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
      {
        role: 'user',
        content: [{
          type: 'text',
          text: 'second prompt',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        }],
      },
    ]);
  });

  it('skips an assistant message ending in thinking and pins the prior message', () => {
    const messages = applyAnthropicMessageCacheBreakpoint([
      { role: 'user', content: [{ type: 'text', text: 'prompt' }] },
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'private', signature: 'sig' }],
      },
    ], '1h');

    expect(messages[0]).toEqual({
      role: 'user',
      content: [{
        type: 'text',
        text: 'prompt',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      }],
    });
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'private', signature: 'sig' }],
    });
  });

  it('places the breakpoint before volatile per-turn context blocks', () => {
    const messages = applyAnthropicMessageCacheBreakpoint([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'actual user prompt' },
          { type: 'text', text: '<active-context>volatile goal state</active-context>' },
          { type: 'text', text: '<system-reminder>one-shot memory</system-reminder>' },
        ],
      },
    ], '1h');

    expect(messages).toEqual([{
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'actual user prompt',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
        { type: 'text', text: '<active-context>volatile goal state</active-context>' },
        { type: 'text', text: '<system-reminder>one-shot memory</system-reminder>' },
      ],
    }]);
  });

  it('pins the prior tool result when the trailing user message is only volatile context', () => {
    const messages = applyAnthropicMessageCacheBreakpoint([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'stable result' }],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: '<active-context>volatile goal state</active-context>' }],
      },
    ], '1h');

    expect(messages).toEqual([
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: 'stable result',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        }],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: '<active-context>volatile goal state</active-context>' }],
      },
    ]);
  });
});
