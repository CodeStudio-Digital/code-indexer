/**
 * Personal cloud-sync for the API-client environments. Manual ("Sync now"):
 * push every local env (structure-only — secrets stay masked), then pull this
 * workspace's changes and apply them locally (idempotent upsert; tombstone →
 * delete). State (workspaceId, clientDocId map, per-doc versions, feed cursor)
 * persists in localStorage per project. A second machine joins by sharing the
 * workspaceId. Conflicts are resolved server-side (LWW) and reported as a count.
 */
import { useCallback, useEffect, useState } from 'react';
import { cloudCall } from '../../../lib/cloud/cloud-client.js';
import { CloudError } from '../../../lib/cloud/cloud-errors.js';
import type { ApiRequest } from '../types.js';
import * as api from '../api.js';
import {
  bodyToUpsert,
  mergeRequestForApply,
  planEnvApply,
  planEnvPush,
  planCollectionApply,
  planCollectionPush,
  requestMatchKey,
  type CollectionBody,
} from './api-sync-core.js';

interface SyncState {
  workspaceId: string;
  /** local env id → clientDocId */
  map: Record<string, string>;
  /** clientDocId → last known server version */
  versions: Record<string, number>;
  /** local collection id → clientDocId */
  colMap: Record<string, string>;
  /** collection clientDocId → last known server version */
  colVersions: Record<string, number>;
  cursor: number;
}

export interface SyncSummary {
  pushed: number;
  conflicts: number;
  pulledApplied: number;
  at: number;
}

const key = (projectId: number) => `mcp-apisync:${projectId}`;
const newId = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`);

function load(projectId: number): SyncState {
  try {
    const raw = localStorage.getItem(key(projectId));
    if (raw) {
      const p = JSON.parse(raw) as Partial<SyncState>;
      return {
        workspaceId: p.workspaceId ?? newId(),
        map: p.map ?? {},
        versions: p.versions ?? {},
        colMap: p.colMap ?? {}, // back-compat: pre-collection-sync state lacks these
        colVersions: p.colVersions ?? {},
        cursor: p.cursor ?? 0,
      };
    }
  } catch {
    /* fall through to a fresh workspace */
  }
  return { workspaceId: newId(), map: {}, versions: {}, colMap: {}, colVersions: {}, cursor: 0 };
}

/** Apply a pulled collection locally, NON-destructively. A fresh collection is
 *  created and its requests inserted as-is. For an existing one we match incoming
 *  requests to local ones by a stable key and PATCH them (merging so blanked
 *  credentials keep their real local value); unmatched incoming requests are
 *  created. Local-only requests are intentionally left in place — wiping them is
 *  what destroyed unpushed work + secrets before. Seeds `colMap` when created. */
async function applyCollection(
  projectId: number,
  body: CollectionBody,
  localId: number | undefined,
  colMap: Record<string, string>,
  clientDocId: string,
): Promise<void> {
  if (localId == null) {
    const created = await api.createCollection(projectId, body.name, body.description);
    colMap[String(created.id)] = clientDocId;
    for (const r of body.requests) {
      await api.createRequest(projectId, created.id, r as Partial<ApiRequest> & { name: string });
    }
    return;
  }
  await api.patchCollection(projectId, localId, { name: body.name, description: body.description });
  const existing = await api.listRequests(projectId, localId);
  const byKey = new Map(existing.map((e) => [requestMatchKey(e), e]));
  for (const r of body.requests) {
    const local = byKey.get(requestMatchKey(r));
    if (local) {
      await api.patchRequest(projectId, local.id, mergeRequestForApply(r, local));
    } else {
      await api.createRequest(projectId, localId, r as Partial<ApiRequest> & { name: string });
    }
  }
}

function save(projectId: number, s: SyncState): void {
  try {
    localStorage.setItem(key(projectId), JSON.stringify(s));
  } catch {
    /* storage full / disabled — sync still works this session */
  }
}

export function useApiSync(projectId: number) {
  const [state, setState] = useState<SyncState>(() => load(projectId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<SyncSummary | null>(null);

  // Re-hydrate when the project changes (the tab is reused across projects).
  useEffect(() => {
    setState(load(projectId));
    setError(null);
    setLast(null);
  }, [projectId]);

  const persist = useCallback((next: SyncState) => { setState(next); save(projectId, next); }, [projectId]);

  const sync = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const cur = load(projectId); // freshest persisted state
      const map = { ...cur.map };
      const versions = { ...cur.versions };
      const colMap = { ...cur.colMap };
      const colVersions = { ...cur.colVersions };
      const now = Date.now();

      // 1) PUSH environments + collections (structure only — secrets stripped).
      const envs = await api.listEnvironments(projectId);
      const envClientDocIdFor = (envId: number): string => {
        const k = String(envId);
        if (!map[k]) map[k] = `${cur.workspaceId}:${newId()}`;
        return map[k];
      };
      const envPush = planEnvPush(envs, envClientDocIdFor, (cid) => versions[cid] ?? 0, now);

      const collections = await api.listCollections(projectId);
      const colItems = await Promise.all(
        collections.map(async (c) => ({ collection: c, requests: await api.listRequests(projectId, c.id) })),
      );
      const colClientDocIdFor = (colId: number): string => {
        const k = String(colId);
        if (!colMap[k]) colMap[k] = `${cur.workspaceId}:${newId()}`;
        return colMap[k];
      };
      const colPush = planCollectionPush(colItems, colClientDocIdFor, (cid) => colVersions[cid] ?? 0, now);

      const pushDocs = [...envPush, ...colPush];
      let conflicts = 0;
      if (pushDocs.length) {
        const res = await cloudCall('sync.push', { documents: pushDocs });
        for (const r of res.results) {
          if (r.kind === 'collection') colVersions[r.clientDocId] = r.version;
          else versions[r.clientDocId] = r.version;
          if (r.status === 'conflict') conflicts += 1;
        }
      }

      // 2) PULL this workspace's changes and apply them locally.
      const pull = await cloudCall('sync.pull', { kinds: ['environment', 'collection'], sinceVersion: cur.cursor });

      const envActions = planEnvApply(pull.documents, cur.workspaceId, (cid) => versions[cid] ?? 0);
      const envLocalId = (cid: string): number | undefined => {
        const hit = Object.entries(map).find(([, v]) => v === cid);
        return hit ? Number(hit[0]) : undefined;
      };
      for (const a of envActions) {
        const localId = envLocalId(a.clientDocId);
        if (a.deleted) {
          if (localId != null) await api.deleteEnvironment(projectId, localId);
          if (localId != null) delete map[String(localId)];
        } else if (a.body) {
          const saved = await api.upsertEnvironment(projectId, bodyToUpsert(a.body, localId));
          map[String(saved.id)] = a.clientDocId;
        }
        versions[a.clientDocId] = a.version;
      }

      const colActions = planCollectionApply(pull.documents, cur.workspaceId, (cid) => colVersions[cid] ?? 0);
      const colLocalId = (cid: string): number | undefined => {
        const hit = Object.entries(colMap).find(([, v]) => v === cid);
        return hit ? Number(hit[0]) : undefined;
      };
      for (const a of colActions) {
        const localId = colLocalId(a.clientDocId);
        if (a.deleted) {
          if (localId != null) {
            await api.deleteCollection(projectId, localId);
            delete colMap[String(localId)];
          }
        } else if (a.body) {
          await applyCollection(projectId, a.body, localId, colMap, a.clientDocId);
        }
        colVersions[a.clientDocId] = a.version;
      }

      persist({ workspaceId: cur.workspaceId, map, versions, colMap, colVersions, cursor: Math.max(cur.cursor, pull.cursor) });
      setLast({ pushed: pushDocs.length, conflicts, pulledApplied: envActions.length + colActions.length, at: now });
    } catch (e) {
      setError(e instanceof CloudError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [projectId, persist]);

  /** Join another machine's workspace by its id — resets local sync bookkeeping
   *  so the next sync pulls that workspace fresh. */
  const linkWorkspace = useCallback((id: string) => {
    const trimmed = id.trim();
    if (!trimmed) return;
    persist({ workspaceId: trimmed, map: {}, versions: {}, colMap: {}, colVersions: {}, cursor: 0 });
    setLast(null);
  }, [persist]);

  return { workspaceId: state.workspaceId, busy, error, last, sync, linkWorkspace };
}
