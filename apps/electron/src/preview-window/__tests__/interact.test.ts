import type { PreviewWindow } from '../cdp.js';
import { describe, expect, it, vi } from 'vitest';
import { dispatchInteraction } from '../interact.js';

function previewWithLocate(result: Record<string, unknown>) {
  const send = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'Runtime.evaluate') return { result: { value: result } };
    return { method, params };
  });
  return { preview: { send } as unknown as PreviewWindow, send };
}

describe('preview interaction truthfulness', () => {
  it('does not report success when a press target cannot be found', async () => {
    const { preview, send } = previewWithLocate({ found: false });

    const result = await dispatchInteraction(preview, 'press', { selector: '#missing', key: 'Enter' });

    expect(result).toEqual({ error: "no focusable element matched '#missing'" });
    expect(send).not.toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.anything());
  });

  it('fills an actionable field without echoing its value in the result', async () => {
    const secret = 'correct horse battery staple';
    const { preview, send } = previewWithLocate({
      found: true,
      focused: true,
      editable: true,
      tag: 'input',
      name: 'Password',
    });

    const result = await dispatchInteraction(preview, 'fill', { selector: '#password', value: secret });

    expect(send).toHaveBeenCalledWith('Input.insertText', { text: secret });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).toMatchObject({ ok: true, insertedChars: secret.length, value: '[redacted]' });
  });
});
