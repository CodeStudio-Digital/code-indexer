/**
 * Unit tests for `applyVisionFallback` — the image→text transform used when
 * the active model can't see images (or the composer "Describe images" flag
 * is on). Pure logic; no DB / native modules.
 */
import { describe, it, expect } from 'vitest';
import { applyVisionFallback } from '../vision-fallback.js';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { IVisionDescriber } from '@mcp/code-agent/core/vision-describer.js';

function img(base64: string, describeHint?: string): AgentMessage['content'][number] {
  return { type: 'image', mediaType: 'image/png', base64, describeHint };
}

/** Records the prompts it was asked to describe, echoes a deterministic text. */
function recordingDescriber(): IVisionDescriber & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async describe(req) {
      prompts.push(req.prompt);
      return `DESC(${req.base64}|${req.prompt})`;
    },
  };
}

describe('applyVisionFallback', () => {
  it('returns messages unchanged when gate is false', async () => {
    const d = recordingDescriber();
    const msgs: AgentMessage[] = [{ role: 'user', content: [img('A')] }];
    const out = await applyVisionFallback({ messages: msgs, gate: false, describer: d });
    expect(out).toBe(msgs);
    expect(d.prompts).toHaveLength(0);
  });

  it('passes through messages without images untouched', async () => {
    const d = recordingDescriber();
    const msgs: AgentMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
    const out = await applyVisionFallback({ messages: msgs, gate: true, describer: d });
    expect(out[0].content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(d.prompts).toHaveLength(0);
  });

  it('replaces an image with its description text', async () => {
    const d = recordingDescriber();
    const msgs: AgentMessage[] = [{ role: 'user', content: [img('A', 'find bugs')] }];
    const out = await applyVisionFallback({ messages: msgs, gate: true, describer: d });
    expect(out[0].content).toHaveLength(1);
    expect(out[0].content[0]).toMatchObject({ type: 'text' });
    expect((out[0].content[0] as { text: string }).text).toContain('DESC(A|find bugs)');
    // describeHint wins as the prompt
    expect(d.prompts).toEqual(['find bugs']);
  });

  it('uses the PRECEDING user text as the prompt when no hint', async () => {
    const d = recordingDescriber();
    const msgs: AgentMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Recreate this dashboard' },
          img('A'),
          { type: 'text', text: '(trailing note — should be ignored)' },
        ],
      },
    ];
    await applyVisionFallback({ messages: msgs, gate: true, describer: d });
    expect(d.prompts).toEqual(['Recreate this dashboard']);
  });

  it('falls back to a default prompt when no hint and no preceding text', async () => {
    const d = recordingDescriber();
    // text comes AFTER the image (mirrors a tool-screenshot synthetic message)
    const msgs: AgentMessage[] = [
      { role: 'user', content: [img('A'), { type: 'text', text: '(Image attached)' }] },
    ];
    await applyVisionFallback({ messages: msgs, gate: true, describer: d });
    expect(d.prompts).toHaveLength(1);
    expect(d.prompts[0]).toContain('visible subject');
    expect(d.prompts[0]).toMatch(/layout.*labels.*visible defects/i);
  });

  it('emits an "omitted" note when no describer is wired', async () => {
    const msgs: AgentMessage[] = [{ role: 'user', content: [img('A')] }];
    const out = await applyVisionFallback({ messages: msgs, gate: true, describer: null });
    expect((out[0].content[0] as { text: string }).text).toMatch(/Image omitted/i);
  });

  it('keeps the raw image + a note when describe throws', async () => {
    const failing: IVisionDescriber = {
      async describe() {
        throw new Error('boom');
      },
    };
    const msgs: AgentMessage[] = [{ role: 'user', content: [img('A')] }];
    const out = await applyVisionFallback({ messages: msgs, gate: true, describer: failing });
    expect(out[0].content[0]).toMatchObject({ type: 'image', base64: 'A' });
    expect((out[0].content[1] as { text: string }).text).toMatch(/unavailable.*boom/i);
  });

  it('does not mutate the input messages', async () => {
    const d = recordingDescriber();
    const original: AgentMessage[] = [{ role: 'user', content: [img('A', 'x')] }];
    const snapshot = JSON.parse(JSON.stringify(original));
    await applyVisionFallback({ messages: original, gate: true, describer: d });
    expect(original).toEqual(snapshot);
  });
});
