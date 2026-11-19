import type { ApiCollection, ApiEnvironment, ApiRequest } from './types.js';

export interface ApiClientState {
  collections: ApiCollection[];
  requests: ApiRequest[];
  environments: ApiEnvironment[];
  activeCollectionId: number | null;
  activeRequestId: number | null;
  /** Open request tabs for the active collection. Positive ids = saved requests;
   *  one negative id (when present) = the live draft. activeRequestId is the active tab. */
  openTabIds: number[];
  selectedEnvId: number | null;
  /** In-memory unsaved "Untitled" request (Postman-style). Not in any collection. */
  draftRequest: ApiRequest | null;
  /** True once the draft has been edited — gates the "discard?" confirm. */
  draftDirty: boolean;
  error: string | null;
  loading: boolean;
}

export const INITIAL_STATE: ApiClientState = {
  collections: [], requests: [], environments: [],
  activeCollectionId: null, activeRequestId: null, openTabIds: [], selectedEnvId: null,
  draftRequest: null, draftDirty: false, error: null, loading: true,
};

/** Close a tab with VS-Code-style neighbor activation; closing the draft tab clears the draft. */
export function closeTabState(prev: ApiClientState, id: number): ApiClientState {
  const idx = prev.openTabIds.indexOf(id);
  if (idx < 0) return prev;
  const openTabIds = prev.openTabIds.filter((x) => x !== id);
  let activeRequestId = prev.activeRequestId;
  if (activeRequestId === id) activeRequestId = openTabIds[idx] ?? openTabIds[idx - 1] ?? null;
  return {
    ...prev,
    openTabIds,
    activeRequestId,
    ...(id < 0 ? { draftRequest: null, draftDirty: false } : {}),
  };
}

/**
 * Close a SET of tabs at once (the context-menu bulk actions). Keeps `keepActive`
 * focused if it survives, else falls back to the last remaining tab; clears the
 * draft if a negative (draft) id is among those removed.
 */
export function removeTabsState(prev: ApiClientState, toRemove: Set<number>, keepActive: number | null): ApiClientState {
  if (toRemove.size === 0) return prev;
  const openTabIds = prev.openTabIds.filter((x) => !toRemove.has(x));
  const closingDraft = prev.draftRequest != null && toRemove.has(prev.draftRequest.id);
  let activeRequestId = keepActive != null && openTabIds.includes(keepActive)
    ? keepActive
    : (prev.activeRequestId != null && openTabIds.includes(prev.activeRequestId) ? prev.activeRequestId : null);
  if (activeRequestId == null) activeRequestId = openTabIds[openTabIds.length - 1] ?? null;
  return {
    ...prev,
    openTabIds,
    activeRequestId,
    ...(closingDraft ? { draftRequest: null, draftDirty: false } : {}),
  };
}

// Unique negative ids so each new draft has a distinct identity — the editor
// keys its local state on request.id, so a fresh draft must change the id.
let draftSeq = 0;

/** A fresh unsaved draft request (synthetic negative id = not persisted). */
export function makeDraft(): ApiRequest {
  return {
    id: (draftSeq -= 1), collection_id: 0, name: 'Untitled Request', method: 'GET', path_template: '',
    headers_json: '[]', query_json: '[]', body_json: null, body_kind: 'none',
    body_raw_lang: null, body_form_json: '[]', body_urlencoded_json: '[]', body_graphql_json: null,
    body_binary_path: null, pre_request_script: null, test_script: null, auth_type: null, auth_json: null,
    folder: null, verified: false, expected_status: null, assert_json: null, last_status: null,
    last_run_at: null, sort_order: 0, source: 'manual', created_at: '', updated_at: '',
  };
}
