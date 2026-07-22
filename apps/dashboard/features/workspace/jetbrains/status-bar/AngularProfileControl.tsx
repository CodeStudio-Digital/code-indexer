import { useEffect, useMemo, useState } from 'react';
import type { LspServerInfo, LspServerStatus } from '@mcp/api-bus';
import { apiCall } from '../../../../lib/api-client.js';

export function AngularProfileControl({
  projectId,
  status,
  onApplied,
}: {
  projectId: number;
  status: LspServerStatus;
  onApplied(): void;
}) {
  const [editing, setEditing] = useState(false);
  const [catalog, setCatalog] = useState<LspServerInfo[]>([]);
  const [selected, setSelected] = useState(status.route?.profileId ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const route = status.route;

  useEffect(() => setSelected(route?.profileId ?? ''), [route?.profileId]);
  useEffect(() => {
    if (!editing || !route?.familyId || catalog.length > 0) return;
    let alive = true;
    void apiCall<LspServerInfo[]>('lsp.listServers')
      .then((servers) => { if (alive) setCatalog(servers); })
      .catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { alive = false; };
  }, [catalog.length, editing, route?.familyId]);

  const profiles = useMemo(() => catalog.filter((server) =>
    server.familyId === route?.familyId
    && !!server.profileId
    && server.supportTier !== 'unsupported'), [catalog, route?.familyId]);

  const canManage = status.state === 'needs-profile' || route?.versionSource === 'override';
  if (!canManage || route?.familyId !== 'angular-language-server' || !route.workspacePath) return null;

  const save = async (profileId: string | null): Promise<void> => {
    if (saving || (profileId !== null && !profileId)) return;
    setSaving(true);
    setError(null);
    try {
      await apiCall('lsp.setAngularProfileOverride', {
        projectId,
        workspacePath: route.workspacePath,
        profileId,
      });
      setEditing(false);
      onApplied();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <button type="button" className="mt-1 rounded border px-1.5 py-0.5 text-[11px] hover:bg-muted" onClick={() => setEditing(true)}>
        Alterar perfil Angular
      </button>
    );
  }

  return (
    <div className="mt-1.5 space-y-1">
      <div className="flex gap-1">
        <select className="h-6 min-w-0 flex-1 rounded border bg-background px-1 text-[11px]" value={selected} onChange={(event) => setSelected(event.target.value)}>
          <option value="">Selecione uma versão...</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.profileId}>{profile.profileId}</option>
          ))}
        </select>
        <button type="button" disabled={saving || !selected} className="rounded border px-1.5 text-[11px] disabled:opacity-50" onClick={() => void save(selected)}>
          Aplicar
        </button>
      </div>
      {route.versionSource === 'override' && (
        <button type="button" disabled={saving} className="text-[10.5px] underline disabled:opacity-50" onClick={() => void save(null)}>
          Usar detecção automática
        </button>
      )}
      {error && <div className="text-[10.5px] text-red-400">{error}</div>}
    </div>
  );
}
