import { describe, it, expect } from 'vitest';
import { isPrematureClose, withStreamResilience } from '../stream-resilience.js';
import type { ChatProvider, ChatRequest } from '../adapter.js';
import type { ChatDelta } from '../wire.js';

const PREMATURE = Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });

function makeProvider(gen: () => AsyncIterable<ChatDelta>): ChatProvider {
  return {
    name: 'test',
    model: 'm',
    setModel(_m: string) {},
    chat: () => gen(),
  } as ChatProvider;
}

async function drain(stream: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const out: ChatDelta[] = [];
  for await (const d of stream) out.push(d);
  return out;
}

describe('isPrematureClose', () => {
  it('detects by code', () => expect(isPrematureClose(PREMATURE)).toBe(true));
  it('detects by message', () =>
    expect(isPrematureClose(new Error('socket: Premature close'))).toBe(true));
  it('detects when nested under cause', () =>
    expect(isPrematureClose(Object.assign(new Error('wrap'), { cause: PREMATURE }))).toBe(true));
  it('ignores unrelated errors', () => expect(isPrematureClose(new Error('boom'))).toBe(false));
  it('ignores non-objects', () => {
    expect(isPrematureClose(null)).toBe(false);
    expect(isPrematureClose('Premature close')).toBe(false);
  });
});

describe('withStreamResilience', () => {
  it('swallows a premature close that fires AFTER done', async () => {
    const p = withStreamResilience(
      makeProvider(async function* () {
        yield { type: 'text_delta', text: 'hi' } as ChatDelta;
        yield { type: 'done' } as ChatDelta;
        throw PREMATURE;
      }),
    );
    const out = await drain(p.chat({} as ChatRequest));
    expect(out.map((d) => d.type)).toEqual(['text_delta', 'done']);
  });

  it('rethrows a premature close BEFORE done (real truncation)', async () => {
    const p = withStreamResilience(
      makeProvider(async function* () {
        yield { type: 'text_delta', text: 'partial' } as ChatDelta;
        throw PREMATURE;
      }),
    );
    await expect(drain(p.chat({} as ChatRequest))).rejects.toThrow('Premature close');
  });

  it('rethrows non-premature errors even after done', async () => {
    const p = withStreamResilience(
      makeProvider(async function* () {
        yield { type: 'done' } as ChatDelta;
        throw new Error('other failure');
      }),
    );
    await expect(drain(p.chat({} as ChatRequest))).rejects.toThrow('other failure');
  });

  it('passes a clean stream through unchanged', async () => {
    const p = withStreamResilience(
      makeProvider(async function* () {
        yield { type: 'text_delta', text: 'a' } as ChatDelta;
        yield { type: 'done' } as ChatDelta;
      }),
    );
    const out = await drain(p.chat({} as ChatRequest));
    expect(out.map((d) => d.type)).toEqual(['text_delta', 'done']);
  });

  it('delegates name / model / setModel to the inner provider', () => {
    let setTo = '';
    const inner = {
      name: 'inner',
      model: 'm1',
      setModel(m: string) {
        setTo = m;
      },
      chat: () => (async function* () {})(),
    } as ChatProvider;
    const p = withStreamResilience(inner);
    expect(p.name).toBe('inner');
    expect(p.model).toBe('m1');
    p.model = 'm2';
    expect(inner.model).toBe('m2');
    p.setModel('m3');
    expect(setTo).toBe('m3');
  });
});
