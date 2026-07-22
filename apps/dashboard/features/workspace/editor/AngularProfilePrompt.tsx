import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { LspServerInfo, LspServerStatus } from '@mcp/api-bus';
import { apiCall } from '../../../lib/api-client.js';

interface AngularProfilePromptProps {
  projectId: number;
  status: LspServerStatus;
  notNowLabel: string;
  onApplied(): Promise<void>;
  onDismiss(): void;
}

function profileMajor(profileId?: string): string {
  return profileId?.replace(/^angular-/, '') ?? '?';
}

export function AngularProfilePrompt({
  projectId,
  status,
  notNowLabel,
  onApplied,
  onDismiss,
}: AngularProfilePromptProps) {
  const [catalog, setCatalog] = useState<LspServerInfo[]>([]);
  const [selected, setSelected] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const route = status.route;
  const canSelect = status.state === 'needs-profile' && !!route?.familyId;

  useEffect(() => {
    if (!canSelect) return;
    let alive = true;
    void apiCall<LspServerInfo[]>('lsp.listServers', undefined)
      .then((servers) => { if (alive) setCatalog(servers); })
      .catch((err) => { if (alive) setError(err instanceof Error ? err.message : String(err)); });
    return () => { alive = false; };
  }, [canSelect]);

  const profiles = useMemo(() => catalog.filter((server) =>
    server.familyId === route?.familyId
    && !!server.profileId
    && server.supportTier !== 'unsupported'), [catalog, route?.familyId]);

  const apply = async (): Promise<void> => {
    if (!route || !selected || saving) return;
    setSaving(true);
    setError(null);
    try {
      await apiCall('lsp.setAngularProfileOverride', {
        projectId,
        workspacePath: route.workspacePath,
        profileId: selected,
      });
      await onApplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pointer-events-auto w-full rounded-md border bg-card/95 shadow-md px-3 py-2 text-[12px]">
      <div className="text-amber-500">
        {status.reason ?? 'Angular version needs an explicit compatibility profile.'}
      </div>
      {route && <div className="mt-1 text-[11px] text-muted-foreground">{route.workspacePath}</div>}
      {canSelect && (
        <div className="mt-2 flex items-center gap-2">
          <select
            aria-label="Angular compatibility version"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
            className="h-7 min-w-0 flex-1 rounded border bg-background px-2 text-[11px]"
          >
            <option value="">Select Angular version...</option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.profileId}>
                Angular {profileMajor(profile.profileId)}
                {profile.supportTier === 'best-effort' ? ' (legacy)' : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!selected || saving}
            onClick={() => void apply()}
            className="inline-flex h-7 items-center gap-1 rounded bg-primary px-2 text-[11px] text-primary-foreground disabled:opacity-50"
          >
            {saving && <Loader2 className="h-3 w-3 animate-spin" />}
            Apply
          </button>
        </div>
      )}
      {error && <div className="mt-1 text-[11px] text-red-400">{error}</div>}
      <button
        type="button"
        onClick={onDismiss}
        className="mt-1.5 rounded border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/40"
      >
        {notNowLabel}
      </button>
    </div>
  );
}
