/** Pure client sync-core tests: secret-safe env serialization, push/apply plans,
 *  workspace-prefix scoping, and "don't re-apply my own pushed docs". */
import { describe, it, expect } from 'vitest';
import type { SyncPullItem } from '@mcp/api-bus';
import { envToBody, bodyToUpsert, planEnvPush, planEnvApply } from '../api-sync-core.js';
import type { ApiEnvironment } from '../../types.js';

const env = (over: Partial<ApiEnvironment> = {}): ApiEnvironment => ({
  id: 1,
  project_id: 7,
  name: 'Prod',
  base_url: 'https://api.x',
  variables_json: JSON.stringify({ HOST: { value: 'x', secret: false }, TOKEN: { value: '••••', secret: true } }),
  is_default: true,
  created_at: '',
  updated_at: '',
  ...over,
});

describe('envToBody / bodyToUpsert', () => {
  it('keeps the masked secret (never a real value) and the secret flag', () => {
    const body = envToBody(env());
    expect(body.variables.TOKEN).toEqual({ value: '••••', secret: true });
    expect(body.variables.HOST).toEqual({ value: 'x', secret: false });
    expect(body.name).toBe('Prod');
    expect(body.baseUrl).toBe('https://api.x');
  });
  it('round-trips body → upsert payload with the local id', () => {
    const up = bodyToUpsert(envToBody(env()), 42);
    expect(up.id).toBe(42);
    expect(up.base_url).toBe('https://api.x');
    expect(up.variables.TOKEN).toEqual({ value: '••••', secret: true });
  });
  it('tolerates malformed variables_json', () => {
    expect(envToBody(env({ variables_json: 'not json' })).variables).toEqual({});
  });
});

describe('planEnvPush', () => {
  it('emits one push item per env with its clientDocId + known baseVersion', () => {
    const items = planEnvPush([env({ id: 1 }), env({ id: 2 })], (id) => `ws:${id}`, (cid) => (cid === 'ws:1' ? 5 : 0), 1234);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'environment', clientDocId: 'ws:1', baseVersion: 5, updatedAtMs: 1234 });
    expect(items[1].baseVersion).toBe(0);
  });
});

describe('planEnvApply', () => {
  const pulled: SyncPullItem[] = [
    { kind: 'environment', clientDocId: 'wsA:1', version: 4, deleted: false, body: { name: 'A', baseUrl: '', isDefault: false, variables: {} } },
    { kind: 'environment', clientDocId: 'wsB:1', version: 5, deleted: false, body: { name: 'other-ws', baseUrl: '', isDefault: false, variables: {} } },
    { kind: 'environment', clientDocId: 'wsA:2', version: 6, deleted: true, body: null },
    { kind: 'collection', clientDocId: 'wsA:9', version: 7, deleted: false, body: {} },
  ];
  it('keeps only this workspace, newer-than-known, and maps tombstones', () => {
    const actions = planEnvApply(pulled, 'wsA', (cid) => (cid === 'wsA:1' ? 4 : 0));
    // wsA:1 skipped (version 4 not > known 4); wsB:* other workspace; collection ignored.
    expect(actions.map((a) => a.clientDocId)).toEqual(['wsA:2']);
    expect(actions[0].deleted).toBe(true);
    expect(actions[0].body).toBeNull();
  });
  it('applies a newer doc from this workspace', () => {
    const actions = planEnvApply(pulled, 'wsA', () => 0);
    expect(actions.map((a) => a.clientDocId).sort()).toEqual(['wsA:1', 'wsA:2']);
  });
});
