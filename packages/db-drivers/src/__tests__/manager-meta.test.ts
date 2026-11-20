import { describe, it, expect } from 'vitest';
import { DbConnectionManager } from '../manager.js';

/**
 * Regression: engine/read-only metadata must live on the SHARED manager, not in
 * a handler closure — otherwise editRow/ddl landing on a different handler
 * instance (IPC vs HTTP route fallback) wrongly report "not connected". A pg pool is
 * created lazily (no socket on construction), so this needs no live DB.
 */
describe('DbConnectionManager meta', () => {
  it('stores + retrieves connection meta and drops it on close', async () => {
    const mgr = new DbConnectionManager();
    await mgr.acquire('conn:1', { engine: 'postgres', host: 'localhost', port: 5432 }, { pinned: true });
    expect(mgr.getMeta('conn:1')).toEqual({});
    mgr.setMeta('conn:1', { engine: 'postgres', readOnly: true });
    expect(mgr.getMeta('conn:1')).toEqual({ engine: 'postgres', readOnly: true });
    // A second handler instance sharing this manager sees the same metadata.
    expect(mgr.getMeta('conn:1')?.engine).toBe('postgres');
    await mgr.closeAll();
    expect(mgr.getMeta('conn:1')).toBeUndefined();
  });

  it('setMeta merges (read-only toggled without losing engine)', async () => {
    const mgr = new DbConnectionManager();
    await mgr.acquire('conn:2', { engine: 'mysql', host: 'h', port: 3306 }, { pinned: true });
    mgr.setMeta('conn:2', { engine: 'mysql' });
    mgr.setMeta('conn:2', { readOnly: true });
    expect(mgr.getMeta('conn:2')).toEqual({ engine: 'mysql', readOnly: true });
    await mgr.closeAll();
  });
});
