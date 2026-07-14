import type { ApiRequest } from './types.js';

/**
 * Fields accepted by POST /collections/:id/requests. Keeping this mapping
 * explicit prevents timestamps/ids from a deleted row leaking into a create.
 */
export function requestRestoreCreateInput(request: ApiRequest): Partial<ApiRequest> & { name: string } {
  return {
    name: request.name,
    method: request.method,
    path_template: request.path_template,
    headers_json: request.headers_json,
    query_json: request.query_json,
    body_json: request.body_json,
    body_kind: request.body_kind,
    body_raw_lang: request.body_raw_lang,
    body_form_json: request.body_form_json,
    body_urlencoded_json: request.body_urlencoded_json,
    body_graphql_json: request.body_graphql_json,
    body_binary_path: request.body_binary_path,
    pre_request_script: request.pre_request_script,
    test_script: request.test_script,
    auth_type: request.auth_type,
    auth_json: request.auth_json,
    folder: request.folder,
    sort_order: request.sort_order,
    source: request.source,
  };
}

/** Fields restored after create because they are not accepted by the create route. */
export function requestRestorePatch(request: ApiRequest): Partial<ApiRequest> {
  return {
    description: request.description ?? null,
    param_docs_json: request.param_docs_json ?? null,
    last_status: request.last_status,
    last_run_at: request.last_run_at,
  };
}

export function parseRequestAssertion(assertJson: string | null): unknown {
  if (!assertJson) return undefined;
  try { return JSON.parse(assertJson) as unknown; }
  catch { return undefined; }
}

/** Do not steal Ctrl+Z from text fields, rich editors or Monaco. */
export function isRequestDeleteUndoShortcut(event: KeyboardEvent): boolean {
  if (event.repeat || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return false;
  const target = event.target;
  if (typeof HTMLElement === 'undefined') return true;
  if (!(target instanceof HTMLElement)) return true;
  if (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return false;
  return !target.closest('[contenteditable="true"], .monaco-editor, [data-undo-scope="editor"]');
}
