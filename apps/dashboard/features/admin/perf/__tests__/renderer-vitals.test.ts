import { describe, it, expect } from 'vitest';
import { loafToRow } from '../renderer-vitals.js';

type Entry = Parameters<typeof loafToRow>[0];
const mk = (
  duration: number,
  name: string,
  scripts?: Array<{ sourceURL?: string; invoker?: string; duration: number }>,
): Entry => ({ duration, name, scripts } as unknown as Entry);

describe('loafToRow', () => {
  it('picks the longest-duration blocking script as the culprit', () => {
    const r = loafToRow(
      mk(300, 'frame', [
        { sourceURL: 'a.js', invoker: 'a', duration: 50 },
        { sourceURL: 'b.js', invoker: 'b', duration: 200 },
        { sourceURL: 'c.js', invoker: 'c', duration: 100 },
      ]),
      1000,
    );
    expect(r).toEqual({ at: 1000, durationMs: 300, name: 'b', script: 'b.js', kind: 'loaf' });
  });

  it('invoker wins over sourceURL for the name; script is always the sourceURL', () => {
    const r = loafToRow(mk(120, 'frame', [{ sourceURL: 'x.js', invoker: 'render(MessageList)', duration: 120 }]), 1000);
    expect(r.name).toBe('render(MessageList)');
    expect(r.script).toBe('x.js');
  });

  it('falls back to sourceURL when there is no invoker', () => {
    const r = loafToRow(mk(120, 'frame', [{ sourceURL: 'x.js', duration: 120 }]), 1000);
    expect(r.name).toBe('x.js');
    expect(r.script).toBe('x.js');
  });

  it('no scripts → name falls back to the entry name, script undefined', () => {
    expect(loafToRow(mk(80, 'long-animation-frame', undefined), 1000)).toEqual({
      at: 1000, durationMs: 80, name: 'long-animation-frame', script: undefined, kind: 'loaf',
    });
  });

  it('empty scripts + no entry name → "animation-frame"', () => {
    const r = loafToRow(mk(80, '', []), 1000);
    expect(r.name).toBe('animation-frame');
    expect(r.script).toBeUndefined();
  });

  it('rounds the duration', () => {
    expect(loafToRow(mk(99.7, 'frame', []), 1000).durationMs).toBe(100);
  });
});
