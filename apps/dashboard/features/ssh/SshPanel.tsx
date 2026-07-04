/**
 * SSH workbench (bottom-panel tab) — saved hosts on the left, open remote
 * shells on the right, scoped to the current project.
 *
 *   ┌───────────────┬──────────────────────────────────────────┐
 *   │ Hosts    [+]  │ [● root@host] [deploy@box]      [+ Quick] │
 *   │ ▸ Production  ├──────────────────────────────────────────┤
 *   │   • web-1     │   SingleTerminal (reused) — active shell  │
 *   │   • db-1      │                                           │
 *   │ ▸ Ungrouped   │                                           │
 *   └───────────────┴──────────────────────────────────────────┘
 *
 * Clicking a saved host resolves its (decrypted) connect spec and opens a
 * shell registered in the shared PTY manager — so the SAME `SingleTerminal`
 * renders it. The TOFU host-key flow lives here, in one place.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X, AlertCircle, Server, Pencil, Trash2, Loader2, ChevronRight, TerminalSquare, ArrowRightLeft, Play, FolderOpen, ShieldCheck, RotateCw, Repeat, Search, Import } from 'lucide-react';
import type { SshConnectSpec, SshHostKeyInfo } from '@mcp/api-bus';
import { ExponentialBackoff, sleep } from '@mcp/shared/sse/BackoffStrategy.js';
import { apiCall, electronApi } from '../../lib/api-client.js';
import { cn } from '../../lib/utils.js';
import { SingleTerminal, TERMINAL_SURFACE_BG } from '../shared/terminal/SingleTerminal.js';
import { useIsDark } from '../builder/preview/files/viewer/useIsDark.js';
import { useSshSessions, type SshShell } from './ssh-sessions.js';
import {
  connectWithTrust,
  runSnippetWithTrust,
  resolveSnippetCommand,
  resolveSpecFromHost,
  listHosts,
  listIdentities,
  deleteHost,
  createHost,
  patchHost,
  importSshConfig,
  type HostKeyDecision,
} from './api.js';
import { HostEditDialog } from './HostEditDialog.js';
import { HostKeyTrustPrompt } from './HostKeyTrustPrompt.js';
import { TunnelsPanel } from './tunnels/TunnelsPanel.js';
import { SnippetsPanel } from './snippets/SnippetsPanel.js';
import { DualPaneFiles } from './files/DualPaneFiles.js';
import { CloudVaultDialog } from './vault/CloudVaultDialog.js';
import type { SshHost, SshIdentity, SshSnippet } from './types.js';

type SshView = 'terminals' | 'files' | 'tunnels' | 'snippets';
const VIEWS: SshView[] = ['terminals', 'files', 'tunnels', 'snippets'];

interface SshPanelProps {
  projectId: number;
}

const EMPTY_SHELLS: readonly SshShell[] = Object.freeze([]);
const UNGROUPED = ' ungrouped';

interface TrustRequest {
  info: SshHostKeyInfo;
  mode: HostKeyDecision;
  resolve: (accepted: boolean) => void;
}

export function SshPanel({ projectId }: SshPanelProps) {
  const { t } = useTranslation('ssh');
  const dark = useIsDark();
  const hasElectron = !!electronApi();

  const shells = useSshSessions((s) => (s.byProject[projectId] ?? EMPTY_SHELLS) as SshShell[]);
  const activeId = useSshSessions((s) => s.activeByProject[projectId]);
  const { add, remove, markExited, setShellState, swapTerminal, setActive } = useSshSessions.getState();
  // Opt-in auto-reconnect (off by default — a clean `exit` shouldn't redial).
  const [autoReconnect, setAutoReconnect] = useState(() => {
    try { return localStorage.getItem('mcp-ssh:autoreconnect') === '1'; } catch { return false; }
  });
  const reconnectingRef = useRef<Set<string>>(new Set());

  const [hosts, setHosts] = useState<SshHost[]>([]);
  const [identities, setIdentities] = useState<SshIdentity[]>([]);
  const [dialog, setDialog] = useState<{ open: boolean; editing: SshHost | null }>({ open: false, editing: null });
  const [vaultOpen, setVaultOpen] = useState(false);
  const [trust, setTrust] = useState<TrustRequest | null>(null);
  const [connecting, setConnecting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<SshView>('terminals');
  const [hostQuery, setHostQuery] = useState('');

  const reload = useCallback(() => {
    void Promise.all([listHosts(projectId), listIdentities(projectId)])
      .then(([h, i]) => {
        setHosts(h);
        setIdentities(i);
      })
      .catch(() => {
        /* offline / no backend — rail just stays empty */
      });
  }, [projectId]);

  useEffect(() => {
    if (hasElectron) reload();
  }, [hasElectron, reload]);

  // One-click import of the user's ~/.ssh/config: create a host per concrete
  // entry (agent auth by default), then resolve ProxyJump → jump_host_id.
  const [importing, setImporting] = useState(false);
  const importConfig = useCallback(async () => {
    setError(null);
    setImporting(true);
    try {
      const entries = await importSshConfig();
      if (entries.length === 0) {
        setError(t('panel.importNone'));
        return;
      }
      const aliasToId = new Map<string, number>();
      for (const h of hosts) aliasToId.set(h.label, h.id); // dedupe against existing
      for (const e of entries) {
        if (aliasToId.has(e.alias)) continue;
        const created = await createHost(projectId, {
          label: e.alias,
          hostname: e.hostName,
          port: e.port ?? 22,
          username: e.user ?? 'root',
          auth_method: 'agent',
          group_name: 'Imported',
          jump_host_id: null,
          agent_forwarding: false,
        });
        aliasToId.set(e.alias, created.id);
      }
      for (const e of entries) {
        const id = aliasToId.get(e.alias);
        const jumpId = e.proxyJump ? aliasToId.get(e.proxyJump) : undefined;
        if (id != null && jumpId != null) await patchHost(projectId, id, { jump_host_id: jumpId });
      }
      reload();
    } catch (e) {
      setError(t('panel.importError', { reason: e instanceof Error ? e.message : String(e) }));
    } finally {
      setImporting(false);
    }
  }, [projectId, hosts, reload, t]);

  const requestTrust = useCallback(
    (info: SshHostKeyInfo, mode: HostKeyDecision) =>
      new Promise<boolean>((resolve) => setTrust({ info, mode, resolve })),
    [],
  );

  const openSpec = useCallback(
    async (spec: SshConnectSpec, label: string) => {
      const res = await connectWithTrust(spec, 80, 24, requestTrust);
      add(projectId, { terminalId: res.terminalId, hostId: spec.hostId, label });
    },
    [projectId, add, requestTrust],
  );

  const connectHost = useCallback(
    async (h: SshHost) => {
      setError(null);
      setConnecting(h.id);
      try {
        const spec = await resolveSpecFromHost(h, hosts, identities);
        await openSpec(spec, h.label);
      } catch (e) {
        setError(t('error.connectFailed', { reason: e instanceof Error ? e.message : String(e) }));
      } finally {
        setConnecting(null);
      }
    },
    [hosts, identities, openSpec, t],
  );

  const runSnippetOnHost = useCallback(
    async (h: SshHost, snippet: SshSnippet) => {
      setError(null);
      try {
        const spec = await resolveSpecFromHost(h, hosts, identities);
        const command = await resolveSnippetCommand(projectId, snippet.command);
        const res = await runSnippetWithTrust(spec, command, requestTrust);
        add(projectId, { terminalId: res.terminalId, hostId: spec.hostId, label: `▷ ${snippet.name}`, kind: 'snippet' });
        setView('terminals');
      } catch (e) {
        setError(t('snippets.runError', { reason: e instanceof Error ? e.message : String(e) }));
      }
    },
    [hosts, identities, requestTrust, add, projectId, t],
  );

  const removeHost = useCallback(
    async (h: SshHost) => {
      if (!window.confirm(t('panel.deleteConfirm', { label: h.label }))) return;
      await deleteHost(projectId, h.id).catch(() => {});
      reload();
    },
    [projectId, reload, t],
  );

  // Closing a tab kills the channel; the connection manager auto-drops the
  // pooled connection once its last shell releases (ref-counted) — so we do
  // NOT force-disconnect here (that would kill sibling shells on the same host).
  const closeShell = useCallback(
    async (shell: SshShell) => {
      remove(projectId, shell.terminalId);
      try {
        await apiCall('terminal.kill', { terminalId: shell.terminalId });
      } catch {
        /* already exited */
      }
    },
    [projectId, remove],
  );

  // Re-open a shell to the SAME saved host and point the tab at the new channel.
  // Drafts (unsaved quick-connects) can't redial — there's no persisted spec.
  const reconnectShell = useCallback(
    async (shell: SshShell): Promise<boolean> => {
      const h = hosts.find((x) => `saved:${x.id}` === shell.hostId);
      if (!h) return false;
      setShellState(projectId, shell.terminalId, 'reconnecting');
      try {
        const spec = await resolveSpecFromHost(h, hosts, identities);
        const res = await connectWithTrust(spec, 80, 24, requestTrust);
        swapTerminal(projectId, shell.terminalId, res.terminalId);
        return true;
      } catch {
        setShellState(projectId, shell.terminalId, 'dropped');
        return false;
      }
    },
    [hosts, identities, projectId, requestTrust, setShellState, swapTerminal],
  );

  // Bounded backoff+jitter redial loop (opt-in). Bails the moment the user closes
  // the tab or it recovers; one loop per terminal (guarded by reconnectingRef).
  const autoReconnectLoop = useCallback(
    async (terminalId: string) => {
      if (reconnectingRef.current.has(terminalId)) return;
      reconnectingRef.current.add(terminalId);
      const backoff = new ExponentialBackoff({ baseMs: 1000, maxMs: 15_000, maxAttempts: 6 });
      try {
        for (let attempt = 0; ; attempt += 1) {
          const base = backoff.nextDelay(attempt);
          if (base == null) break; // exhausted → stays 'dropped' for a manual retry
          await sleep(Math.round(Math.random() * base)); // full jitter (avoid reconnect storms)
          const shell = useSshSessions.getState().byProject[projectId]?.find((x) => x.terminalId === terminalId);
          if (!shell || shell.state !== 'dropped') break; // closed or recovered elsewhere
          if (await reconnectShell(shell)) break; // success — swapTerminal already ran
        }
      } catch {
        /* sleep aborted */
      } finally {
        reconnectingRef.current.delete(terminalId);
      }
    },
    [projectId, reconnectShell],
  );

  // PTY exit: a snippet's tab STAYS (read its log); a shell channel close (network
  // blip or `exit`) keeps the tab as 'dropped' with a Reconnect affordance, and
  // auto-redials when the user opted in (and the host is saved).
  const onTerminalExited = useCallback(
    (shell: SshShell) => {
      if (shell.kind === 'snippet') {
        markExited(projectId, shell.terminalId);
        return;
      }
      setShellState(projectId, shell.terminalId, 'dropped');
      if (autoReconnect && hosts.some((x) => `saved:${x.id}` === shell.hostId)) void autoReconnectLoop(shell.terminalId);
    },
    [projectId, markExited, setShellState, autoReconnect, hosts, autoReconnectLoop],
  );

  const toggleAutoReconnect = useCallback(() => {
    setAutoReconnect((v) => {
      const next = !v;
      try { localStorage.setItem('mcp-ssh:autoreconnect', next ? '1' : '0'); } catch { /* */ }
      return next;
    });
  }, []);

  if (!hasElectron) {
    return (
      <div className="h-full grid place-items-center text-xs text-muted-foreground gap-2 p-3 text-center">
        <AlertCircle className="h-4 w-4" />
        <span>{t('panel.emptyHint')}</span>
      </div>
    );
  }

  // Filter by a free-text query over label / hostname / username / group / tags.
  const q = hostQuery.trim().toLowerCase();
  const filteredHosts = q
    ? hosts.filter((h) =>
        [h.label, h.hostname, h.username, h.group_name ?? '', h.tags_json]
          .join(' ')
          .toLowerCase()
          .includes(q),
      )
    : hosts;

  // Group hosts by group_name (null → ungrouped, sorted last).
  const groups = new Map<string, SshHost[]>();
  for (const h of filteredHosts) {
    const key = h.group_name?.trim() || UNGROUPED;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(h);
  }
  const groupKeys = [...groups.keys()].sort((a, b) =>
    a === UNGROUPED ? 1 : b === UNGROUPED ? -1 : a.localeCompare(b),
  );

  return (
    <div className="h-full flex min-h-0">
      {/* Host rail */}
      <div className="w-56 shrink-0 border-r flex flex-col min-h-0 bg-card/30">
        <div className="h-8 shrink-0 border-b flex items-center justify-between px-2">
          <span className="text-xs font-medium text-muted-foreground">{t('panel.hosts')}</span>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              aria-label={t('panel.importConfig')}
              title={t('panel.importConfig')}
              disabled={importing}
              onClick={() => void importConfig()}
              className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50"
            >
              {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Import className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              aria-label={t('vault.open')}
              title={t('vault.open')}
              onClick={() => setVaultOpen(true)}
              className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              aria-label={t('panel.newHost')}
              onClick={() => setDialog({ open: true, editing: null })}
              className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        {hosts.length > 4 && (
          <div className="shrink-0 border-b px-2 py-1.5">
            <div className="relative">
              <Search className="h-3 w-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                value={hostQuery}
                onChange={(e) => setHostQuery(e.target.value)}
                placeholder={t('panel.searchHosts')}
                className="w-full h-6 text-[11px] bg-background border rounded pl-6 pr-2"
              />
            </div>
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-y-auto py-1">
          {hosts.length === 0 && (
            <div className="px-3 py-4 text-[11px] text-muted-foreground text-center">{t('panel.noHosts')}</div>
          )}
          {groupKeys.map((gk) => (
            <div key={gk} className="mb-1">
              {(groupKeys.length > 1 || gk !== UNGROUPED) && (
                <div className="flex items-center gap-1 px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                  <ChevronRight className="h-3 w-3" />
                  {gk === UNGROUPED ? t('panel.ungrouped') : gk}
                </div>
              )}
              {groups.get(gk)!.map((h) => (
                <div
                  key={h.id}
                  className="group flex items-center gap-1.5 px-2 py-1 mx-1 rounded text-xs cursor-pointer hover:bg-muted"
                  onClick={() => void connectHost(h)}
                  title={`${h.username}@${h.hostname}:${h.port}`}
                >
                  {connecting === h.id ? (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                  ) : (
                    <Server className="h-3 w-3 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate flex-1">{h.label}</span>
                  <button
                    type="button"
                    aria-label={t('panel.edit')}
                    className="opacity-0 group-hover:opacity-60 hover:!opacity-100 p-0.5"
                    onClick={(e) => { e.stopPropagation(); setDialog({ open: true, editing: h }); }}
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    aria-label={t('panel.delete')}
                    className="opacity-0 group-hover:opacity-60 hover:!opacity-100 p-0.5"
                    onClick={(e) => { e.stopPropagation(); void removeHost(h); }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Right pane: view switcher + shells/tunnels */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="h-8 shrink-0 border-b flex items-center px-1 gap-1">
          {VIEWS.map((v) => {
            const Icon =
              v === 'terminals' ? TerminalSquare : v === 'files' ? FolderOpen : v === 'tunnels' ? ArrowRightLeft : Play;
            return (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={cn(
                  'flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors',
                  view === v ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted',
                )}
              >
                <Icon className="h-3 w-3" />
                {t(`view.${v}`)}
              </button>
            );
          })}
        </div>

        {view === 'files' ? (
          <DualPaneFiles projectId={projectId} hosts={hosts} identities={identities} onNeedTrust={requestTrust} />
        ) : view === 'tunnels' ? (
          <TunnelsPanel hosts={hosts} identities={identities} />
        ) : view === 'snippets' ? (
          <SnippetsPanel projectId={projectId} hosts={hosts} onRun={(h, s) => void runSnippetOnHost(h, s)} />
        ) : (
          <SshTerminals
            projectId={projectId}
            shells={shells}
            activeId={activeId}
            dark={dark}
            error={error}
            autoReconnect={autoReconnect}
            onToggleAutoReconnect={toggleAutoReconnect}
            onReconnect={(s) => void reconnectShell(s)}
            onSelect={(id) => setActive(projectId, id)}
            onClose={closeShell}
            onExited={onTerminalExited}
            onNew={() => setDialog({ open: true, editing: null })}
          />
        )}
      </div>

      <HostEditDialog
        projectId={projectId}
        open={dialog.open}
        initial={dialog.editing}
        hosts={hosts}
        onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))}
        onSaved={reload}
      />

      <CloudVaultDialog
        projectId={projectId}
        open={vaultOpen}
        onOpenChange={(o) => {
          setVaultOpen(o);
          if (!o) reload(); // a pull may have created/updated hosts
        }}
      />

      {trust && (
        <HostKeyTrustPrompt
          info={trust.info}
          mode={trust.mode}
          onDecision={(accepted) => {
            trust.resolve(accepted);
            setTrust(null);
          }}
        />
      )}
    </div>
  );
}

/** The terminals view: shell tab bar + the active SingleTerminal. */
function SshTerminals({
  shells,
  activeId,
  dark,
  error,
  autoReconnect,
  onToggleAutoReconnect,
  onReconnect,
  onSelect,
  onClose,
  onExited,
  onNew,
}: {
  projectId: number;
  shells: SshShell[];
  activeId: string | undefined;
  dark: boolean;
  error: string | null;
  autoReconnect: boolean;
  onToggleAutoReconnect: () => void;
  onReconnect: (shell: SshShell) => void;
  onSelect: (id: string) => void;
  onClose: (shell: SshShell) => void;
  onExited: (shell: SshShell) => void;
  onNew: () => void;
}) {
  const { t } = useTranslation('ssh');
  const activeShell = shells.find((x) => x.terminalId === activeId);
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="h-8 shrink-0 border-b flex items-center px-1 gap-0.5 overflow-x-auto">
        <div className="flex items-center gap-0.5 flex-1 min-w-0">
          {shells.map((shell) => {
            const active = shell.terminalId === activeId;
            return (
              <div
                key={shell.terminalId}
                className={cn(
                  'group flex items-center gap-1.5 pl-2 pr-1 py-1 rounded text-xs cursor-pointer transition-colors',
                  active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted',
                )}
                onClick={() => onSelect(shell.terminalId)}
                title={shell.state === 'dropped' ? t('panel.dropped') : shell.exited ? t('panel.exited') : undefined}
              >
                {shell.state === 'reconnecting' ? (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                ) : shell.state === 'dropped' ? (
                  <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
                ) : shell.exited ? (
                  <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                ) : (
                  <Server className="h-3 w-3 shrink-0" />
                )}
                <span className={cn('truncate max-w-[140px]', (shell.exited || shell.state === 'dropped') && 'opacity-60')}>{shell.label}</span>
                <button
                  type="button"
                  aria-label={t('panel.closeTab')}
                  className="opacity-50 hover:opacity-100 rounded p-0.5"
                  onClick={(e) => { e.stopPropagation(); onClose(shell); }}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          aria-label={t('panel.autoReconnect')}
          title={t(autoReconnect ? 'panel.autoReconnectOn' : 'panel.autoReconnectOff')}
          onClick={onToggleAutoReconnect}
          className={cn('shrink-0 rounded p-1 hover:bg-muted', autoReconnect ? 'text-emerald-500' : 'text-muted-foreground')}
        >
          <Repeat className="h-3.5 w-3.5" />
        </button>
      </div>

      {error && <div className="px-2 py-1 text-[10px] text-red-400 border-b bg-red-500/10 shrink-0">{error}</div>}

      <div
        className="flex-1 min-h-0 relative"
        style={{ background: dark ? TERMINAL_SURFACE_BG.dark : TERMINAL_SURFACE_BG.light }}
      >
        {activeShell?.state === 'dropped' && (
          <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 px-3 py-1.5 bg-red-500/10 border-b border-red-500/30 text-[11px]">
            <AlertCircle className="h-3.5 w-3.5 text-red-400 shrink-0" />
            <span className="flex-1 text-red-300">{t('panel.disconnected')}</span>
            <button
              type="button"
              onClick={() => onReconnect(activeShell)}
              className="inline-flex items-center gap-1 rounded px-2 py-0.5 border border-input bg-background/60 hover:bg-muted transition-colors"
            >
              <RotateCw className="h-3 w-3" /> {t('panel.reconnect')}
            </button>
          </div>
        )}
        {activeShell?.state === 'reconnecting' && (
          <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/30 text-[11px] text-amber-300">
            <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
            <span>{t('panel.reconnecting')}</span>
          </div>
        )}
        {shells.length === 0 && (
          <div className="absolute inset-0 grid place-items-center text-center text-xs text-muted-foreground gap-2 p-4">
            <Server className="h-5 w-5 opacity-60" />
            <div>{t('panel.empty')}</div>
            <button
              type="button"
              onClick={onNew}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-input hover:bg-muted transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>{t('panel.newHost')}</span>
            </button>
          </div>
        )}
        {activeId && (
          <SingleTerminal
            key={activeId}
            terminalId={activeId}
            onProcessExited={() => {
              const shell = shells.find((x) => x.terminalId === activeId);
              if (shell) onExited(shell);
            }}
          />
        )}
      </div>
    </div>
  );
}
