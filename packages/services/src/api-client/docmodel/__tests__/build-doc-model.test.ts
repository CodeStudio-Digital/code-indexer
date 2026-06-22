import { describe, it, expect } from 'vitest';
import { buildDocModel } from '../build-doc-model.js';
import type { ApiCollection, ApiRequest, ApiDocPage, ApiRequestExample } from '@mcp/store/api-client-types.js';

const collection = {
  id: 1, project_id: 1, name: 'Catracas', description: 'API de catracas',
  spec_source: null, spec_hash: null, folders_json: '["Auth"]',
  overview_md: '# Welcome', branding_json: '{"name":"AABB","accent":"#f00"}',
  folder_docs_json: '{"Auth":"Authentication endpoints"}',
  created_at: '', updated_at: '2026-01-01',
} as ApiCollection;

const request = {
  id: 10, collection_id: 1, name: 'Login', method: 'post', path_template: 'https://x.com/auth/login?x=1',
  headers_json: '[]', query_json: '[]', body_json: '{"u":"a"}', body_kind: 'json',
  body_raw_lang: null, body_form_json: '[]', body_urlencoded_json: '[]', body_graphql_json: null,
  body_binary_path: null, pre_request_script: null, test_script: null, auth_type: null, auth_json: null,
  description: 'Logs a user in', param_docs_json: '{"query:x":"the x param"}', folder: 'Auth',
  verified: false, expected_status: null, assert_json: null, last_status: null, last_run_at: null,
  sort_order: 0, source: 'manual', created_at: '', updated_at: '',
} as ApiRequest;

const page = { id: 5, collection_id: 1, slug: 'getting-started', title: 'Getting Started', body_md: 'do this', sort_order: 0, created_at: '', updated_at: '' } as ApiDocPage;
const example = { id: 7, request_id: 10, name: 'happy', req_snapshot_json: '{"method":"POST","url":"https://x.com/auth/login"}', resp_status: 200, resp_status_text: 'OK', resp_headers_json: '{"content-type":"application/json"}', resp_body: '{"token":"x"}', resp_content_type: 'application/json', resp_size: 12, redaction_count: 1, sort_order: 0, created_at: '', updated_at: '' } as ApiRequestExample;

describe('buildDocModel', () => {
  const model = buildDocModel({ collection, requests: [request], docPages: [page], examplesByRequest: new Map([[10, [example]]]) });

  it('carries collection meta, overview, branding and guides', () => {
    expect(model.meta.title).toBe('Catracas');
    expect(model.overview).toBe('# Welcome');
    expect(model.branding.accent).toBe('#f00');
    expect(model.guides[0].title).toBe('Getting Started');
  });

  it('lists folders with their descriptions', () => {
    expect(model.folders.find((f) => f.name === 'Auth')?.description).toBe('Authentication endpoints');
  });

  it('builds endpoints with description, param docs, path, samples and examples', () => {
    const ep = model.endpoints[0];
    expect(ep.method).toBe('POST');
    expect(ep.path).toBe('/auth/login');
    expect(ep.description).toBe('Logs a user in');
    expect(ep.paramDocs).toEqual([{ in: 'query', name: 'x', description: 'the x param' }]);
    expect(ep.samples.length).toBeGreaterThan(0);
    expect(ep.examples[0].name).toBe('happy');
    expect(ep.examples[0].status).toBe(200);
  });

  it('emits an OpenAPI doc folding in the endpoint description', () => {
    const oa = model.openapi as { paths: Record<string, Record<string, { description?: string }>> };
    expect(oa.paths['/auth/login'].post.description).toBe('Logs a user in');
  });
});
