/** Active sessions (devices) + a global sign-out. logout-all revokes every
 *  session (incl. this one), which the main process turns into a logged-out
 *  broadcast. */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CloudSessionInfo } from '@mcp/api-bus';
import { Button } from '../../components/ui/button.js';
import { cloudCall } from '../../lib/cloud/cloud-client.js';
import { useCloudAction } from '../../lib/cloud/use-cloud-action.js';

export function SessionsSection() {
  const { t } = useTranslation('cloud');
  const { busy, run } = useCloudAction();
  const [sessions, setSessions] = useState<CloudSessionInfo[]>([]);

  const load = () =>
    void run(async () => setSessions((await cloudCall('auth.sessions', undefined)).sessions));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-2">
      <ul className="space-y-1.5">
        {sessions.map((s) => {
          // Prefer real device identity over the generic transport UA ("node").
          const primary = s.deviceName || s.userAgent || s.id;
          const geo = [s.geoCity, s.geoCountry].filter(Boolean).join(', ');
          const meta = [s.osRelease, geo].filter(Boolean).join(' · ');
          return (
            <li key={s.id} className="flex items-start justify-between gap-2 text-xs">
              <div className="min-w-0">
                <div className="truncate">{primary}</div>
                {meta ? <div className="truncate text-[11px] text-muted-foreground">{meta}</div> : null}
              </div>
              {s.current ? <span className="ml-2 shrink-0 rounded bg-muted px-1.5 py-0.5">{t('sessions.thisDevice')}</span> : null}
            </li>
          );
        })}
      </ul>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void cloudCall('auth.logoutAll', undefined)}>
        {t('sessions.revokeAll')}
      </Button>
    </div>
  );
}
