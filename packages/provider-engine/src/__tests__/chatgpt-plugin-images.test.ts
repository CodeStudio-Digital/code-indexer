import { describe, expect, it } from 'vitest';
import { chatgptSpec as pluginChatgptSpec } from '../../../../extensions/provider-chatgpt/src/spec.js';
import { chatgptSpec as canonicalChatgptSpec } from '../specs/chatgpt.js';

describe('bundled ChatGPT provider image capability', () => {
  it('stays in sync with the canonical ChatGPT provider catalog', () => {
    expect(pluginChatgptSpec).toEqual(canonicalChatgptSpec);
  });

  it('declares server-managed image capability', () => {
    expect(pluginChatgptSpec.capabilities).toMatchObject({
      supportsImageGen: true,
      supportsVision: true,
      fileInput: 'native',
    });
  });
});
