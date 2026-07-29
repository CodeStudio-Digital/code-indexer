/**
 * Admin → Language servers: catalog (install/remove with streamed npm log)
 * + live per-project instances (state, restart). The editor CTA banner is
 * the other install entry point — both share lsp.installServerStream.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Languages, Loader2, RefreshCw, RotateCw, Trash2 } from 'lucide-react';
import { apiCall, apiStream, electronApi } from '../../lib/api-client.js';
import { Button } from '../../components/ui/button.js';
import { useTranslation } from 'react-i18next';
import type { LspInstallFrame, LspServerInfo } from '@mcp/api-bus';

interface Instance {
  projectId: number;
  serverId: string;
  routeId?: string;
  profileId?: string;
  state: string;
  lastExitReason?: string;
  stderrTail?: string;
}

export function LspServersPanel() {
  const { t } = useTranslation('admin');
  const [servers, setServers] = useState<LspServerInfo[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, i] = await Promise.all([
        apiCall<LspServerInfo[]>('lsp.listServers'),
        apiCall<Instance[]>('lsp.instances'),
      ]);
      setServers(s);
      setInstances(i);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const install = async (serverId: string): Promise<void> => {
    setBusy(serverId);
    setError(null);
    setLog('');
    try {
      if (electronApi()) {
        for await (const f of apiStream<LspInstallFrame>('lsp.installServerStream', { serverId })) {
          if (f.phase === 'log') setLog(f.line);
          if (f.phase === 'error') throw new Error(f.message);
          if (f.phase === 'done') break;
        }
      } else {
        await new Promise<void>((resolve, reject) => {
          const es = new EventSource(`/api/lsp/servers/${serverId}/install/stream`);
          es.addEventListener('install', (ev) => {
            const f = JSON.parse((ev as MessageEvent).data) as LspInstallFrame;
            if (f.phase === 'log') setLog(f.line);
            if (f.phase === 'error') { es.close(); reject(new Error(f.message)); }
            if (f.phase === 'done') { es.close(); resolve(); }
          });
          es.onerror = () => { es.close(); reject(new Error('install stream dropped')); };
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setLog('');
      void refresh();
    }
  };

  const remove = async (serverId: string): Promise<void> => {
    setBusy(serverId);
    setError(null);
    try {
      const result = await apiCall<{ ok: boolean }>('lsp.removeServer', { serverId });
      if (!result.ok) throw new Error('Não foi possível remover o language server. Verifique se o processo ainda está em uso.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const restart = async (inst: Instance): Promise<void> => {
    try {
      await apiCall('lsp.restartServer', {
        projectId: inst.projectId,
        serverId: inst.serverId,
        routeId: inst.routeId,
      });
    } catch { /* best-effort */ }
    void refresh();
  };

  const serverGroups = useMemo(() => {
    const grouped = new Map<string, LspServerInfo[]>();
    for (const server of servers) {
      const key = server.familyId ?? server.id;
      grouped.set(key, [...(grouped.get(key) ?? []), server]);
    }
    return [...grouped.entries()];
  }, [servers]);

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Languages className="h-4 w-4 text-primary" /> Language servers
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            Inteligência real (completion, hover, diagnostics) por linguagem. Instalação local em
            <code className="mx-1">~/.mcp-code-indexer/lsp-servers</code> — nada baixa sem clique.
            Sem server instalado, o índice estrutural cobre navegação básica.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" /> Atualizar
        </Button>
      </div>

      {error && <div className="text-xs text-red-400 border border-red-400/30 rounded px-2 py-1">{error}</div>}

      <div className="space-y-2">
        {serverGroups.map(([familyId, family]) => (
          <div key={familyId} className="rounded-md border bg-card/30 p-2 space-y-1.5">
            {family.length > 1 && (
              <div className="px-1 text-[12px] font-semibold">
                {family[0]?.label}
                <span className="ml-2 font-normal text-muted-foreground">
                  {t('lspServers.profileCount', { count: family.length })}
                </span>
              </div>
            )}
            {family.map((s) => (
          <div key={s.id} className="rounded border bg-card/40 px-3 py-2 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">
                {family.length > 1 ? s.profileId ?? s.label : s.label}
                {s.supportTier === 'best-effort' && (
                  <span className="ml-2 text-[10px] text-amber-400">{t('lspServers.legacy')}</span>
                )}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {s.languages.join(', ')} · v{s.version} · {s.sizeLabel}
              </div>
              {busy === s.id && log && (
                <div className="text-[10px] font-mono text-muted-foreground truncate mt-1">{log}</div>
              )}
            </div>
            {s.installed ? (
              <span className="text-[11px] text-emerald-500/90 mr-2">instalado</span>
            ) : (
              <span className="text-[11px] text-muted-foreground mr-2">não instalado</span>
            )}
            {busy === s.id ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : s.installed ? (
              <Button variant="outline" size="sm" onClick={() => void remove(s.id)}>
                <Trash2 className="h-3.5 w-3.5 mr-1" /> Remover
              </Button>
            ) : (
              <Button size="sm" onClick={() => void install(s.id)}>
                <Download className="h-3.5 w-3.5 mr-1" /> Instalar
              </Button>
            )}
          </div>
            ))}
          </div>
        ))}
      </div>

      <div>
        <h3 className="text-xs font-semibold text-muted-foreground mb-2">Instâncias em execução</h3>
        {instances.length === 0 ? (
          <div className="text-[11px] text-muted-foreground">
            {t('lspServers.emptyInstances')}
          </div>
        ) : (
          <div className="space-y-1">
            {instances.map((i) => (
              <div
                key={`${i.projectId}:${i.routeId ?? i.serverId}`}
                className="rounded border bg-card/30 px-2 py-1"
              >
                <div className="flex items-center gap-3 text-[11.5px]">
                  <span className="font-mono">{i.serverId}</span>
                  {i.profileId && <span className="text-muted-foreground">{i.profileId}</span>}
                  <span className="text-muted-foreground">projeto #{i.projectId}</span>
                  <span
                    className={
                      i.state === 'ready'
                        ? 'text-emerald-500/90'
                        : i.state === 'failed' || i.state === 'crashed'
                          ? 'text-red-400'
                          : 'text-amber-400'
                    }
                  >
                    {i.state}
                  </span>
                  <span className="flex-1" />
                  <Button variant="ghost" size="sm" onClick={() => void restart(i)}>
                    <RotateCw className="h-3 w-3 mr-1" /> Restart
                  </Button>
                </div>
                {(i.lastExitReason || i.stderrTail) && (
                  <details className="mt-1">
                    <summary className="text-[10.5px] text-amber-400/90 cursor-pointer select-none">
                      {i.lastExitReason ? `motivo: ${i.lastExitReason}` : 'stderr'}
                    </summary>
                    {i.stderrTail && (
                      <pre className="mt-1 text-[10px] font-mono whitespace-pre-wrap text-muted-foreground/80 max-h-40 overflow-auto border rounded p-1 bg-background/40">
                        {i.stderrTail}
                      </pre>
                    )}
                  </details>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
