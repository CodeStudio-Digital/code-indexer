/** Active sessions (devices) — real device identity (P7-A): name · OS · city,country
 *  · last seen. "Sign out everywhere" revokes all sessions (the API has no
 *  per-session revoke; current-session logout lives in the sidebar). */
import { useCallback, useEffect, useState } from 'react';
import { Laptop } from 'lucide-react';
import type { CloudSessionInfo } from '@mcp/api-bus';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { Alert, Badge, Button, Card, CardContent, Spinner } from '../lib/ui.js';

export function DevicesPage() {
  const { signOut } = useAuth();
  const [sessions, setSessions] = useState<CloudSessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSessions((await api.sessions()).sessions);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load devices.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revokeAll = async () => {
    if (!confirm('Sign out of every device, including this one?')) return;
    setBusy(true);
    try {
      await signOut(true); // logout-all → clears local + redirects via RequireAuth
    } finally {
      setBusy(false);
    }
  };

  const fmt = (iso: string) => {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Devices</h1>
          <p className="text-sm text-muted-foreground">Sessions currently signed in to your account.</p>
        </div>
        <Button variant="destructive" size="sm" loading={busy} onClick={() => void revokeAll()}>
          Sign out everywhere
        </Button>
      </div>

      {error ? <Alert>{error}</Alert> : null}

      {!sessions ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading…
        </div>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No active sessions.</p>
      ) : (
        <Card>
          <CardContent className="divide-y p-0">
            {sessions.map((s) => {
              const geo = [s.geoCity, s.geoCountry].filter(Boolean).join(', ');
              const meta = [s.osRelease, geo].filter(Boolean).join(' · ');
              return (
                <div key={s.id} className="flex items-start gap-3 p-4">
                  <Laptop className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{s.deviceName || s.userAgent || s.id}</span>
                      {s.current ? <Badge tone="success">This device</Badge> : null}
                    </div>
                    {meta ? <div className="truncate text-xs text-muted-foreground">{meta}</div> : null}
                    <div className="text-xs text-muted-foreground">Last seen {fmt(s.lastSeenAt)}</div>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
