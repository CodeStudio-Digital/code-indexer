import { describe, it, expect } from 'vitest';
import { exportPostman, type ExportRequest } from '../export-postman.js';
import { exportOpenApi } from '../export-openapi.js';

const req = (over: Partial<ExportRequest> = {}): ExportRequest => ({
  name: 'List users',
  method: 'GET',
  path_template: 'https://api.test/users',
  headers_json: '[{"key":"Accept","value":"application/json","enabled":true}]',
  query_json: '[{"key":"page","value":"2","enabled":true}]',
  body_json: null,
  body_kind: 'none',
  ...over,
});

describe('exportPostman', () => {
  it('emits a v2.1 collection with items', () => {
    const doc = exportPostman('My API', [req(), req({ name: 'Create', method: 'POST', body_kind: 'json', body_json: '{"a":1}' })]) as any;
    expect(doc.info.schema).toContain('v2.1.0');
    expect(doc.item).toHaveLength(2);
    expect(doc.item[0].request.method).toBe('GET');
    expect(doc.item[1].request.body.mode).toBe('raw');
  });

  it('does not throw on empty / legacy / null fields', () => {
    expect(() => exportPostman('Empty', [])).not.toThrow();
    expect(() => exportPostman('Legacy', [req({ body_kind: 'form', body_urlencoded_json: '[]', headers_json: '{"X":"1"}', query_json: '{}' })])).not.toThrow();
    expect(() => exportPostman('GQL', [req({ body_kind: 'graphql', body_graphql_json: null })])).not.toThrow();
  });

  it('is JSON-serializable (no circular refs / undefined keys break it)', () => {
    const doc = exportPostman('My API', [req({ body_kind: 'graphql', body_graphql_json: '{"query":"{me}","variables":"{}"}' })]);
    expect(() => JSON.stringify(doc)).not.toThrow();
  });

  it('nests requests into folders (top-level first, folders sorted)', () => {
    const doc = exportPostman('API', [
      req({ name: 'A', folder: 'Auth' }),
      req({ name: 'B' }),
      req({ name: 'C', folder: 'Auth' }),
    ]) as any;
    expect(doc.item[0].name).toBe('B'); // folderless first
    const auth = doc.item.find((i: any) => i.name === 'Auth');
    expect(auth.item.map((i: any) => i.name)).toEqual(['A', 'C']);
  });
});

describe('exportOpenApi', () => {
  it('emits a 3.1 doc keyed by path+method', () => {
    const doc = exportOpenApi('My API', [req(), req({ name: 'Create', method: 'POST', path_template: '/users', body_kind: 'json', body_json: '{"a":1}' })]) as any;
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.paths['/users'].get).toBeTruthy();
    expect(doc.paths['/users'].post.requestBody.content['application/json']).toBeTruthy();
  });

  it('does not throw on empty / null body', () => {
    expect(() => exportOpenApi('Empty', [])).not.toThrow();
    expect(() => JSON.stringify(exportOpenApi('My API', [req()]))).not.toThrow();
  });

  it('emits tags from folders', () => {
    const doc = exportOpenApi('API', [req({ folder: 'Users', path_template: '/u' })]) as any;
    expect(doc.tags).toEqual([{ name: 'Users' }]);
    expect(doc.paths['/u'].get.tags).toEqual(['Users']);
  });
});
