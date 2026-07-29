/**
 * Port-forwarding panel — start/stop local, remote and dynamic (SOCKS5)
 * tunnels over a saved host's pooled connection, with live byte counters.
 * Active tunnels are polled from the backend (`ssh.tunnelList`).
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, ArrowRightLeft, Square, Loader2 } from 'lucide-react';
import type { SshTunnel, SshTunnelKind } from '@mcp/api-bus';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../../../components/ui/select.js';
import { findHostByKey, sshHostKey, tunnelList, tunnelStart, tunnelStop, resolveSpecFromHost } from '../api.js';
import type { SshHost, SshIdentity } from '../types.js';

interface TunnelsPanelProps {
  hosts: SshHost[];
  identities: SshIdentity[];
}

const FIELD = 'flex flex-col gap-1';
const LABEL = 'text-[10px] uppercase tracking-wide text-muted-foreground/70';

/** Poll cadence while traffic is moving, and once the counters go quiet. */
const FAST_POLL_MS = 1500;
const SLOW_POLL_MS = 5000;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function parsePort(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65_535 ? n : null;
}

export function TunnelsPanel({ hosts, identities }: TunnelsPanelProps) {
  const { t } = useTranslation('ssh');
  const [tunnels, setTunnels] = useState<SshTunnel[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [hostId, setHostId] = useState<string>('');
  const [kind, setKind] = useState<SshTunnelKind>('local');
  const [bindPort, setBindPort] = useState('');
  const [destHost, setDestHost] = useState('localhost');
  const [destPort, setDestPort] = useState('');
  const host = findHostByKey(hosts, hostId);
  const bindPortNumber = parsePort(bindPort);
  const destPortNumber = parsePort(destPort);
  const needsDest = kind !== 'dynamic';
  const canStart = !!host && bindPortNumber != null && (!needsDest || (!!destHost.trim() && destPortNumber != null));
  const bindPortLabel = kind === 'remote'
    ? t('tunnels.remoteBindPort')
    : kind === 'dynamic'
      ? t('tunnels.socksPort')
      : t('tunnels.localBindPort');
  const destHostLabel = kind === 'remote' ? t('tunnels.remoteDestHost') : t('tunnels.localDestHost');
  const destPortLabel = kind === 'remote' ? t('tunnels.remoteDestPort') : t('tunnels.localDestPort');
  const preview = kind === 'dynamic'
    ? t('tunnels.previewDynamic', { bindPort: bindPort || '?' })
    : kind === 'remote'
      ? t('tunnels.previewRemote', { bindPort: bindPort || '?', destHost: destHost.trim() || '?', destPort: destPort || '?' })
      : t('tunnels.previewLocal', { bindPort: bindPort || '?', destHost: destHost.trim() || '?', destPort: destPort || '?' });

  const refresh = useCallback(() => {
    void tunnelList().then(setTunnels).catch(() => undefined);
  }, []);

  /**
   * Poll active tunnels (and their byte counters).
   *
   * Adaptive rather than a flat 1.5 s: the old loop issued an IPC round-trip
   * every 1.5 s for as long as the tab was mounted, even with ZERO tunnels and
   * even while the window was hidden — pure background churn on the main
   * process. Now it pauses when the document is hidden, stops entirely with no
   * tunnels (a start/stop refreshes explicitly), and backs off to 5 s while the
   * counters are unchanged so an idle tunnel costs almost nothing.
   */
  const tunnelCount = tunnels.length;
  useEffect(() => {
    refresh();
    if (tunnelCount === 0) return;
    let timer: ReturnType<typeof setTimeout>;
    let delay = FAST_POLL_MS;
    let lastSignature = '';

    const tick = async (): Promise<void> => {
      if (document.visibilityState === 'visible') {
        try {
          const list = await tunnelList();
          setTunnels(list);
          const signature = list.map((x) => `${x.id}:${x.bytesUp}:${x.bytesDown}`).join('|');
          delay = signature === lastSignature ? SLOW_POLL_MS : FAST_POLL_MS;
          lastSignature = signature;
        } catch {
          delay = SLOW_POLL_MS;
        }
      }
      timer = setTimeout(() => void tick(), delay);
    };

    timer = setTimeout(() => void tick(), delay);
    return () => clearTimeout(timer);
  }, [refresh, tunnelCount]);

  async function start(): Promise<void> {
    setError(null);
    if (!host || bindPortNumber == null || (needsDest && (!destHost.trim() || destPortNumber == null))) {
      setError(t('tunnels.validation'));
      return;
    }
    setBusy(true);
    try {
      const spec = await resolveSpecFromHost(host, hosts, identities);
      await tunnelStart({
        spec,
        kind,
        bindPort: bindPortNumber,
        destHost: needsDest ? destHost.trim() : undefined,
        destPort: needsDest ? destPortNumber! : undefined,
      });
      setShowForm(false);
      setBindPort('');
      setDestPort('');
      refresh();
    } catch (e) {
      setError(t('tunnels.startError', { reason: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }

  const route = (tn: SshTunnel): string =>
    tn.kind === 'dynamic'
      ? t('tunnels.routeDynamic', { bindHost: tn.bindHost, bindPort: tn.bindPort })
      : tn.kind === 'remote'
        ? t('tunnels.routeRemote', { bindHost: tn.bindHost, bindPort: tn.bindPort, destHost: tn.destHost, destPort: tn.destPort })
        : t('tunnels.routeLocal', { bindHost: tn.bindHost, bindPort: tn.bindPort, destHost: tn.destHost, destPort: tn.destPort });

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="h-8 shrink-0 border-b flex items-center justify-between px-2">
        <span className="text-xs font-medium text-muted-foreground">{t('tunnels.title')}</span>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted"
        >
          <Plus className="h-3 w-3" />
          {t('tunnels.new')}
        </button>
      </div>

      {showForm && (
        <div className="border-b p-2 grid gap-2 bg-card/30">
          <div className="grid grid-cols-2 gap-2">
            <div className={FIELD}>
              <span className={LABEL}>{t('tunnels.host')}</span>
              <Select value={hostId} onValueChange={setHostId}>
                <SelectTrigger className="h-8"><SelectValue placeholder={t('tunnels.selectHost')} /></SelectTrigger>
                <SelectContent>
                  {hosts.map((h) => (
                    <SelectItem key={sshHostKey(h)} value={sshHostKey(h)}>{h.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className={FIELD}>
              <span className={LABEL}>{t('tunnels.kind')}</span>
              <Select value={kind} onValueChange={(v) => setKind(v as SshTunnelKind)}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">{t('tunnels.kindLocal')}</SelectItem>
                  <SelectItem value="remote">{t('tunnels.kindRemote')}</SelectItem>
                  <SelectItem value="dynamic">{t('tunnels.kindDynamic')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className={FIELD}>
              <span className={LABEL}>{bindPortLabel}</span>
              <Input
                className="h-8"
                value={bindPort}
                inputMode="numeric"
                min={1}
                max={65535}
                placeholder={kind === 'dynamic' ? '1080' : kind === 'remote' ? '19000' : '18081'}
                title={bindPortLabel}
                onChange={(e) => setBindPort(e.target.value.replace(/[^\d]/g, ''))}
              />
            </div>
            {kind !== 'dynamic' && (
              <>
                <div className={FIELD}>
                  <span className={LABEL}>{destHostLabel}</span>
                  <Input className="h-8" value={destHost} title={destHostLabel} onChange={(e) => setDestHost(e.target.value)} />
                </div>
                <div className={FIELD}>
                  <span className={LABEL}>{destPortLabel}</span>
                  <Input
                    className="h-8"
                    value={destPort}
                    inputMode="numeric"
                    min={1}
                    max={65535}
                    placeholder={kind === 'remote' ? '9000' : '18080'}
                    title={destPortLabel}
                    onChange={(e) => setDestPort(e.target.value.replace(/[^\d]/g, ''))}
                  />
                </div>
              </>
            )}
          </div>
          <div className="font-mono text-[11px] text-muted-foreground truncate" title={preview}>{preview}</div>
          {error && <p className="text-xs text-red-500">{error}</p>}
          <div className="flex justify-end">
            <Button size="sm" onClick={start} disabled={busy || !canStart}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t('tunnels.start')}
            </Button>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {tunnels.length === 0 && (
          <div className="grid place-items-center h-full text-xs text-muted-foreground gap-2">
            <ArrowRightLeft className="h-5 w-5 opacity-60" />
            <span>{t('tunnels.none')}</span>
          </div>
        )}
        {tunnels.map((tn) => (
          <div key={tn.id} className="flex items-center gap-2 px-3 py-2 border-b text-xs">
            <ArrowRightLeft className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="font-mono truncate flex-1" title={route(tn)}>{route(tn)}</span>
            <span className="text-muted-foreground tabular-nums shrink-0">
              ↑{fmtBytes(tn.bytesUp)} ↓{fmtBytes(tn.bytesDown)}
            </span>
            <button
              type="button"
              aria-label={t('tunnels.stop')}
              onClick={() => void tunnelStop(tn.id).then(refresh)}
              className="text-muted-foreground hover:text-red-500 p-0.5"
            >
              <Square className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
