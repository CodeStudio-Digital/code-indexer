/** Collection sync core — the security-critical redaction + push/apply planning. */
import { describe, it, expect } from 'vitest';
import type { SyncPullItem } from '@mcp/api-bus';
import type { ApiCollection, ApiRequest } from '../../types.js';
import {
  redactRequestForSync,
  collectionToBody,
  planCollectionPush,
  planCollectionApply,
  mergeRequestForApply,
  requestMatchKey,
  type CollectionBody,
} from '../api-sync-core.js';

function mkReq(over: Partial<ApiRequest> = {}): ApiRequest {
  return {
    id: 1,
    collection_id: 1,
    name: 'Req',
    method: 'GET',
    path_template: '/v1/things',
    headers_json: '[]',
    query_json: '[]',
    body_json: null,
    body_kind: 'none',
    body_raw_lang: null,
    body_form_json: '[]',
    body_urlencoded_json: '[]',
    body_graphql_json: null,
    body_binary_path: null,
    pre_request_script: null,
    test_script: null,
    auth_type: null,
    auth_json: null,
    description: null,
    folder: null,
    verified: false,
    expected_status: null,
    assert_json: null,
    last_status: null,
    last_run_at: null,
    sort_order: 0,
    source: 'manual',
    created_at: '',
    updated_at: '',
    ...over,
  };
}

const mkCol = (over: Partial<ApiCollection> = {}): ApiCollection => ({
  id: 1,
  project_id: 1,
  name: 'My API',
  description: 'desc',
  spec_source: null,
  spec_hash: null,
  folders_json: '["Auth"]',
  created_at: '',
  updated_at: '',
  ...over,
});

describe('redactRequestForSync', () => {
  it('blanks the auth credential but keeps the type/non-secret fields', () => {
    const r = redactRequestForSync(mkReq({ auth_type: 'bearer', auth_json: '{"type":"bearer","token":"sk-supersecretvalue123"}' }));
    expect(r.auth_type).toBe('bearer');
    expect(JSON.parse(r.auth_json!)).toEqual({ type: 'bearer', token: '' });
  });

  it('blanks credential-named headers/query values, keeps the rest', () => {
    const r = redactRequestForSync(
      mkReq({
        headers_json: '[{"key":"Authorization","value":"Bearer abc","enabled":true},{"key":"Accept","value":"application/json","enabled":true}]',
        query_json: '[{"key":"api_key","value":"xyz123","enabled":true},{"key":"page","value":"1","enabled":true}]',
      }),
    );
    const headers = JSON.parse(r.headers_json) as { key: string; value: string }[];
    expect(headers.find((h) => h.key === 'Authorization')!.value).toBe('');
    expect(headers.find((h) => h.key === 'Accept')!.value).toBe('application/json');
    const query = JSON.parse(r.query_json) as { key: string; value: string }[];
    expect(query.find((q) => q.key === 'api_key')!.value).toBe('');
    expect(query.find((q) => q.key === 'page')!.value).toBe('1');
  });

  it('redacts literal secrets (JWT) in a json body but leaves structure', () => {
    const r = redactRequestForSync(mkReq({ body_kind: 'json', body_json: '{"jwt":"eyJhbGciOi.aaaaaaa.bbbbbbb","name":"ok"}' }));
    expect(r.body_json).not.toContain('eyJhbGciOi.aaaaaaa.bbbbbbb');
    expect(r.body_json).toContain('"name":"ok"');
  });

  it('never syncs the host-local binary upload path', () => {
    const r = redactRequestForSync(mkReq({ body_kind: 'binary', body_binary_path: '/home/me/secret.bin' }));
    expect(r.body_binary_path).toBeNull();
  });

  it('preserves non-secret structure (method, path, folder, scripts)', () => {
    const r = redactRequestForSync(mkReq({ method: 'POST', path_template: '/x', folder: 'Auth', test_script: 'pm.test("ok",()=>{})' }));
    expect(r.method).toBe('POST');
    expect(r.path_template).toBe('/x');
    expect(r.folder).toBe('Auth');
    expect(r.test_script).toContain('pm.test');
  });
});

describe('collectionToBody + planCollectionPush', () => {
  it('embeds redacted requests + collection metadata', () => {
    const body = collectionToBody(mkCol(), [mkReq({ auth_type: 'bearer', auth_json: '{"type":"bearer","token":"sk-x"}' })]);
    expect(body).toMatchObject({ name: 'My API', description: 'desc', folders_json: '["Auth"]' });
    expect(body.requests).toHaveLength(1);
    expect(JSON.parse(body.requests[0].auth_json!).token).toBe('');
  });

  it('builds a push item per collection (kind=collection, clientDocId, baseVersion)', () => {
    const items = [{ collection: mkCol({ id: 7 }), requests: [] }];
    const push = planCollectionPush(items, (id) => `ws1:c${id}`, (cid) => (cid === 'ws1:c7' ? 3 : 0), 123);
    expect(push).toHaveLength(1);
    expect(push[0]).toMatchObject({ kind: 'collection', clientDocId: 'ws1:c7', baseVersion: 3, updatedAtMs: 123 });
    expect((push[0].body as CollectionBody).name).toBe('My API');
  });
});

describe('planCollectionApply', () => {
  const pulled: SyncPullItem[] = [
    { kind: 'collection', clientDocId: 'ws1:a', version: 5, deleted: false, body: { name: 'A', description: '', folders_json: '[]', requests: [] } },
    { kind: 'collection', clientDocId: 'ws1:b', version: 4, deleted: true, body: null },
    { kind: 'collection', clientDocId: 'ws2:c', version: 9, deleted: false, body: { name: 'OtherWs', description: '', folders_json: '[]', requests: [] } },
    { kind: 'environment', clientDocId: 'ws1:e', version: 9, deleted: false, body: {} },
  ];

  it('keeps only this-workspace, newer collection docs; maps tombstones to null', () => {
    const actions = planCollectionApply(pulled, 'ws1', (cid) => (cid === 'ws1:a' ? 5 : 0));
    // ws1:a skipped (5 not > 5); ws2:c other workspace; environment ignored; ws1:b tombstone kept.
    expect(actions.map((a) => a.clientDocId)).toEqual(['ws1:b']);
    expect(actions[0].deleted).toBe(true);
    expect(actions[0].body).toBeNull();
  });

  it('includes a fresh collection with its body', () => {
    const actions = planCollectionApply(pulled, 'ws1', () => 0);
    const a = actions.find((x) => x.clientDocId === 'ws1:a')!;
    expect(a.body?.name).toBe('A');
    expect(actions.some((x) => x.clientDocId === 'ws2:c')).toBe(false); // never cross-workspace
  });
});

describe('requestMatchKey', () => {
  it('is stable across method case and matches a redacted body to its local row', () => {
    const local = mkReq({ method: 'get', name: 'List', path_template: '/v1/x' });
    expect(requestMatchKey(local)).toBe(requestMatchKey({ method: 'GET', name: 'List', path_template: '/v1/x' }));
    // The synced (redacted) body keys identically to the local request it came from.
    expect(requestMatchKey(redactRequestForSync(local))).toBe(requestMatchKey(local));
  });

  it('differs when name/method/path differ', () => {
    const a = requestMatchKey(mkReq({ name: 'A' }));
    expect(a).not.toBe(requestMatchKey(mkReq({ name: 'B' })));
    expect(a).not.toBe(requestMatchKey(mkReq({ name: 'A', method: 'POST' })));
  });
});

describe('mergeRequestForApply (non-destructive, secret-preserving)', () => {
  it('restores a blanked auth token from the local request', () => {
    const local = mkReq({ auth_type: 'bearer', auth_json: '{"type":"bearer","token":"sk-LOCALSECRET"}' });
    const merged = mergeRequestForApply(redactRequestForSync(local), local);
    expect(JSON.parse(merged.auth_json!)).toEqual({ type: 'bearer', token: 'sk-LOCALSECRET' });
  });

  it('restores blanked credential header/query values, keeps non-credential ones', () => {
    const local = mkReq({
      headers_json: '[{"key":"Authorization","value":"Bearer abc","enabled":true},{"key":"Accept","value":"application/json","enabled":true}]',
      query_json: '[{"key":"api_key","value":"xyz123","enabled":true},{"key":"page","value":"1","enabled":true}]',
    });
    const merged = mergeRequestForApply(redactRequestForSync(local), local);
    const headers = JSON.parse(merged.headers_json!) as { key: string; value: string }[];
    expect(headers.find((h) => h.key === 'Authorization')!.value).toBe('Bearer abc');
    expect(headers.find((h) => h.key === 'Accept')!.value).toBe('application/json');
    const query = JSON.parse(merged.query_json!) as { key: string; value: string }[];
    expect(query.find((q) => q.key === 'api_key')!.value).toBe('xyz123');
    expect(query.find((q) => q.key === 'page')!.value).toBe('1');
  });

  it('keeps the local body when the incoming one differs only by redaction', () => {
    const local = mkReq({ body_kind: 'json', body_json: '{"jwt":"eyJhbGciOi.aaaaaaa.bbbbbbb","name":"ok"}' });
    const merged = mergeRequestForApply(redactRequestForSync(local), local);
    expect(merged.body_json).toBe('{"jwt":"eyJhbGciOi.aaaaaaa.bbbbbbb","name":"ok"}');
  });

  it('honors a genuine remote body edit', () => {
    const local = mkReq({ body_kind: 'json', body_json: '{"name":"local"}' });
    const incoming = redactRequestForSync(mkReq({ body_kind: 'json', body_json: '{"name":"REMOTE"}' }));
    const merged = mergeRequestForApply(incoming, local);
    expect(merged.body_json).toBe('{"name":"REMOTE"}');
  });

  it('takes non-credential fields from the incoming body', () => {
    const local = mkReq({ description: 'old', folder: 'A' });
    const incoming = redactRequestForSync(mkReq({ description: 'new', folder: 'B', method: 'POST' }));
    const merged = mergeRequestForApply(incoming, local);
    expect(merged.description).toBe('new');
    expect(merged.folder).toBe('B');
    expect(merged.method).toBe('POST');
  });

  it('preserves the host-local binary path (never carried by sync)', () => {
    const local = mkReq({ body_kind: 'binary', body_binary_path: '/home/me/file.bin' });
    const merged = mergeRequestForApply(redactRequestForSync(local), local);
    expect(merged.body_binary_path).toBe('/home/me/file.bin');
  });
});
