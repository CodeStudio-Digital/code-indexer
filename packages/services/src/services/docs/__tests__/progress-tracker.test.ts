import { describe, it, expect } from 'vitest';
import { DocIngestProgressTracker } from '../progress-tracker.js';

describe('DocIngestProgressTracker', () => {
  it('returns null for unknown sources', () => {
    const t = new DocIngestProgressTracker();
    expect(t.get(42)).toBeNull();
  });

  it('stores the latest frame and stamps updated_at', () => {
    const t = new DocIngestProgressTracker();
    const before = Date.now();
    t.put(7, { phase: 'embedding', current: 100, total: 500 });
    const snap = t.get(7);
    expect(snap).not.toBeNull();
    expect(snap!.source_id).toBe(7);
    expect(snap!.phase).toBe('embedding');
    expect(snap!.current).toBe(100);
    expect(snap!.updated_at).toBeGreaterThanOrEqual(before);
  });

  it('overwrites with newer frames', () => {
    const t = new DocIngestProgressTracker();
    t.put(7, { phase: 'fetching', current: 1, total: 10 });
    t.put(7, { phase: 'embedding', current: 200, total: 500 });
    expect(t.get(7)?.phase).toBe('embedding');
    expect(t.get(7)?.current).toBe(200);
  });

  it('clear drops only the targeted source', () => {
    const t = new DocIngestProgressTracker();
    t.put(7, { phase: 'embedding', current: 1, total: 10 });
    t.put(8, { phase: 'embedding', current: 1, total: 10 });
    t.clear(7);
    expect(t.get(7)).toBeNull();
    expect(t.get(8)).not.toBeNull();
    expect(t.size()).toBe(1);
  });
});
