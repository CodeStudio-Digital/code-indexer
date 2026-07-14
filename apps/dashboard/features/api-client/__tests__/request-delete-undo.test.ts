import { describe, expect, it } from 'vitest';
import {
  isRequestDeleteUndoShortcut,
  parseRequestAssertion,
  requestRestoreCreateInput,
  requestRestorePatch,
} from '../request-delete-undo.js';
import type { ApiRequest } from '../types.js';

const request: ApiRequest = {
  id: 42,
  collection_id: 7,
  name: 'Create user',
  method: 'POST',
  path_template: '/users',
  headers_json: '[{"key":"x","value":"y","enabled":true}]',
  query_json: '[]',
  body_json: '{"name":"Ada"}',
  body_kind: 'json',
  body_raw_lang: null,
  body_form_json: '[]',
  body_urlencoded_json: '[]',
  body_graphql_json: null,
  body_binary_path: null,
  pre_request_script: 'pm.variables.set("a", "b")',
  test_script: 'pm.test("ok", () => {})',
  auth_type: 'bearer',
  auth_json: '{"token":"{{token}}"}',
  description: 'Creates one user',
  param_docs_json: '{"header:x":"tenant"}',
  folder: 'Users',
  verified: true,
  expected_status: 201,
  assert_json: '{"body":{"id":"number"}}',
  last_status: 201,
  last_run_at: '2026-07-13T10:00:00.000Z',
  sort_order: 3,
  source: 'manual',
  created_at: '2026-07-01T10:00:00.000Z',
  updated_at: '2026-07-13T10:00:00.000Z',
};

describe('request deletion undo helpers', () => {
  it('restores request content without reusing row identity or timestamps', () => {
    const create = requestRestoreCreateInput(request);
    expect(create).toMatchObject({ name: request.name, method: 'POST', body_json: request.body_json, folder: 'Users' });
    expect(create).not.toHaveProperty('id');
    expect(create).not.toHaveProperty('collection_id');
    expect(create).not.toHaveProperty('created_at');
    expect(requestRestorePatch(request)).toEqual({
      description: request.description,
      param_docs_json: request.param_docs_json,
      last_status: 201,
      last_run_at: request.last_run_at,
    });
    expect(parseRequestAssertion(request.assert_json)).toEqual({ body: { id: 'number' } });
  });

  it('only claims Ctrl/Cmd+Z outside editable controls', () => {
    const event = (overrides: Partial<KeyboardEvent> = {}) => ({
      key: 'z', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
      repeat: false, target: null, ...overrides,
    } as KeyboardEvent);
    expect(isRequestDeleteUndoShortcut(event())).toBe(true);
    expect(isRequestDeleteUndoShortcut(event({ metaKey: true, ctrlKey: false }))).toBe(true);
    expect(isRequestDeleteUndoShortcut(event({ repeat: true }))).toBe(false);
    expect(isRequestDeleteUndoShortcut(event({ shiftKey: true }))).toBe(false);
  });
});
