/**
 * Rail do DS Studio — aba Versões: lista compacta de versões (status,
 * bump, published_at), controle do próximo bump e instalação do MCP da
 * última publicada. Os dados vêm do polling do DsStudioRail.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Server } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import {
  installDesignSystemMcp,
  setNextBumpHint,
  type DesignSystemSessionDetail,
  type DesignSystemVersion,
  type DsBumpHint,
} from '../design-system-api.js';

export function VersionsPanel({
  detail,
  onChanged,
}: {
  detail: DesignSystemSessionDetail;
  onChanged: () => void;
}) {
  const { t } = useTranslation('designSystems');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { session, versions, latest_published: latestPublished } = detail;

  async function setHint(hint: DsBumpHint) {
    setBusy(true);
    setNotice(null);
    try {
      await setNextBumpHint(session.id, hint);
      onChanged();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function installMcp() {
    if (!latestPublished) return;
    setBusy(true);
    setNotice(null);
    try {
      const r = await installDesignSystemMcp(session.id, latestPublished.semver);
      setNotice(`✓ ${t('session.mcpInstalledNotice', { id: r.mcp_server_config_id })}`);
      onChanged();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 p-3">
      <div>
        <div className="mb-1 text-xs font-medium text-muted-foreground">{t('session.setNextBump')}</div>
        <div className="flex gap-1">
          {(['patch', 'minor', 'major'] as DsBumpHint[]).map((h) => (
            <Button
              key={h}
              variant={session.next_bump_hint === h ? 'default' : 'outline'}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => void setHint(h)}
              disabled={busy}
            >
              {h}
            </Button>
          ))}
        </div>
      </div>

      {latestPublished?.mcp_manifest_json && (
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => void installMcp()}
          disabled={busy}
        >
          {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Server className="mr-1 h-3.5 w-3.5" />}
          {session.mcp_server_config_id ? t('session.reinstallMcp') : t('session.installMcp')}
        </Button>
      )}

      {notice && <div className="rounded border bg-muted/30 p-2 text-xs">{notice}</div>}

      {versions.length === 0 ? (
        <div className="rounded border border-dashed p-4 text-center text-xs text-muted-foreground">
          {t('studio.versionsEmpty')}
        </div>
      ) : (
        <ul className="space-y-1.5">
          {versions.map((v) => (
            <VersionRow key={v.id} version={v} />
          ))}
        </ul>
      )}
    </div>
  );
}

function VersionRow({ version }: { version: DesignSystemVersion }) {
  const tone =
    version.status === 'published' ? 'border-emerald-300 bg-emerald-50 text-emerald-800' :
    version.status === 'building'  ? 'border-sky-300 bg-sky-50 text-sky-800' :
    version.status === 'failed'    ? 'border-red-300 bg-red-50 text-red-800' :
    version.status === 'skipped'   ? 'border-zinc-300 bg-zinc-50 text-zinc-700' :
                                      'border-amber-300 bg-amber-50 text-amber-800';
  return (
    <li className="rounded border p-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono font-medium">{version.semver}</span>
        <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${tone}`}>
          {version.status}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        {version.bump_kind}
        {version.published_at ? ` · ${version.published_at}` : ''}
      </div>
      {version.error && <div className="mt-1 break-words text-[11px] text-red-600">{version.error}</div>}
    </li>
  );
}
