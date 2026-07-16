/**
 * Fetch das fichas de dados ("Seus dados") — introspecção do D1 local via
 * GET /api/app-studio/apps/:id/data. Refetch manual + no mount.
 */
import { useCallback, useEffect, useState } from 'react';

export interface AppDataColumn {
  name: string;
  label: string;
  type: string;
  required?: boolean;
  primary_key?: boolean;
  references?: { table: string; column: string; label: string } | null;
}

export interface AppDataRelation {
  from_table: string;
  from_label: string;
  from_column: string;
  to_table: string;
  to_label: string;
  to_column: string;
}

export interface AppDataTable {
  name: string;
  label: string;
  columns: AppDataColumn[];
  row_count: number;
  samples: Array<Record<string, unknown>>;
  relations_out?: AppDataRelation[];
  relations_in?: AppDataRelation[];
  health?: { status: 'ok' | 'warning'; issues: string[] };
}

export interface AppDataProvisionState {
  needed: boolean;
  issues: string[];
}

interface DataResponse {
  tables: AppDataTable[] | null;
  relations?: AppDataRelation[];
  provision?: AppDataProvisionState;
  reason?: string;
  error?: string;
}

export interface AppDataProvisionResult {
  ok: true;
  applied: string[];
  provision: AppDataProvisionState | null;
}

export interface AppDataQueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  row_count: number;
  limited: boolean;
  duration_ms: number;
}

export function useAppData(sessionId: number, enabled: boolean): {
  tables: AppDataTable[] | null;
  provision: AppDataProvisionState | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [tables, setTables] = useState<AppDataTable[] | null>(null);
  const [provision, setProvision] = useState<AppDataProvisionState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!enabled) return;
    setLoading(true);
    void fetch(`/api/app-studio/apps/${sessionId}/data`)
      .then(async (r) => {
        const body = (await r.json()) as DataResponse;
        if (!r.ok || body.error) throw new Error(body.error ?? r.statusText);
        setTables(body.tables ?? null);
        setProvision(body.provision ?? null);
        setError(null);
      })
      .catch((e: Error) => {
        setProvision(null);
        setError(e.message);
      })
      .finally(() => setLoading(false));
  }, [sessionId, enabled]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { tables, provision, loading, error, refresh };
}

export async function fetchTableSheet(
  sessionId: number,
  table: string,
): Promise<{ columns: string[]; rows: Array<Record<string, unknown>> }> {
  const r = await fetch(`/api/app-studio/apps/${sessionId}/data?table=${encodeURIComponent(table)}`);
  const body = (await r.json()) as { columns?: string[]; rows?: Array<Record<string, unknown>>; error?: string };
  if (!r.ok || body.error) throw new Error(body.error ?? r.statusText);
  return { columns: body.columns ?? [], rows: body.rows ?? [] };
}

export async function runAppDataQuery(sessionId: number, sql: string): Promise<AppDataQueryResult> {
  const r = await fetch(`/api/app-studio/apps/${sessionId}/data/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  const body = (await r.json()) as Partial<AppDataQueryResult> & { error?: string };
  if (!r.ok || body.error) throw new Error(body.error ?? r.statusText);
  return {
    columns: body.columns ?? [],
    rows: body.rows ?? [],
    row_count: body.row_count ?? 0,
    limited: body.limited === true,
    duration_ms: body.duration_ms ?? 0,
  };
}

export async function provisionAppData(sessionId: number): Promise<AppDataProvisionResult> {
  const r = await fetch(`/api/app-studio/apps/${sessionId}/data/provision`, { method: 'POST' });
  const body = (await r.json()) as Partial<AppDataProvisionResult> & { error?: string };
  if (!r.ok || body.error) throw new Error(body.error ?? r.statusText);
  return {
    ok: true,
    applied: body.applied ?? [],
    provision: body.provision ?? null,
  };
}
