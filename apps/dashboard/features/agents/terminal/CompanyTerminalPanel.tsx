/**
 * Company-session terminal panel.
 *
 * Same UX as `WorkspaceTerminal` (multi-tab, persistence, replay on
 * re-attach) but scoped to a company session and capable of spawning
 * terminals against multiple targets:
 *
 *   - Host       — the operator's own machine
 *   - Sandbox    — the company session's container, when builder mode
 *                  provisioned one
 *   - Projeto N  — one entry per project linked to the session, useful
 *                  for opening a shell rooted at a specific repo
 *
 * The "+" button is a split control: click to spawn against the last
 * used target (default: Host), or click the chevron to pick a target
 * explicitly. Each tab remembers its target via `TerminalSession.target`
 * so a refresh/restart picks up the same kind of shell.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Plus } from 'lucide-react';
import { apiCall, electronApi } from '../../../lib/api-client.js';
import {
  companyScope,
  useTerminalSessions,
  type TerminalSession,
  type TerminalSpawnTarget,
} from '../../../state/terminal-sessions.js';
import { SingleTerminal, TERMINAL_SURFACE_BG } from '../../shared/terminal/SingleTerminal.js';
import { TerminalTabBar, type SpawnTargetOption } from '../../shared/terminal/TerminalTabBar.js';
import { useShellPicker } from '../../shared/terminal/use-shell-picker.js';
import { useIsDark } from '../../builder/preview/files/viewer/useIsDark.js';

interface CompanyTerminalPanelProps {
  companySessionId: number;
  /**
   * Project links from `getCompanySessionFull(id).projects`. Each entry
   * with a known `project_name` becomes a spawn-target option. Missing
   * names fall back to `project-<id>` for the menu label.
   */
  projects: Array<{ project_id: number; project_name?: string }>;
  /**
   * True when the session has provisioned a builder sandbox (container).
   * Drives the "Sandbox" target option in the spawn menu.
   */
  hasSandbox: boolean;
}

interface SpawnResult {
  terminalId: string;
  pid: number;
  shell: string;
  cwd: string;
}

const EMPTY_SESSIONS: readonly TerminalSession[] = Object.freeze([]);

const HOST_OPTION_ID = 'host';
const SANDBOX_OPTION_ID = 'sandbox';
const PROJECT_OPTION_PREFIX = 'project:';

export function CompanyTerminalPanel({
  companySessionId,
  projects,
  hasSandbox,
}: CompanyTerminalPanelProps) {
  const scope = companyScope(companySessionId);
  const sessions = useTerminalSessions(
    (s) => (s.byScope[scope] ?? EMPTY_SESSIONS) as TerminalSession[],
  );
  const activeId = useTerminalSessions((s) => s.activeByScope[scope]);
  const { addSession, removeSession, setActive, replaceSessions } = useTerminalSessions.getState();

  const hasElectron = !!electronApi();
  const dark = useIsDark();
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Remember the last successful target so "+" (without opening the
   * chevron menu) keeps spawning the same kind of shell. Defaults to
   * host because that's the safest fallback when neither sandbox nor
   * projects are configured.
   */
  const [lastTargetId, setLastTargetId] = useState<string>(HOST_OPTION_ID);
  const { shells, activeShell, selectShell, addCustomShell } = useShellPicker();

  const spawnOptions: SpawnTargetOption[] = useMemo(() => {
    const opts: SpawnTargetOption[] = [
      { id: HOST_OPTION_ID, label: 'Host (sua máquina)', hint: 'Shell padrão do sistema' },
    ];
    if (hasSandbox) {
      opts.push({
        id: SANDBOX_OPTION_ID,
        label: 'Sandbox',
        hint: 'Container builder desta sessão',
      });
    }
    for (const p of projects) {
      opts.push({
        id: `${PROJECT_OPTION_PREFIX}${p.project_id}`,
        label: p.project_name ?? `project-${p.project_id}`,
        hint: 'Diretório raiz do projeto',
      });
    }
    return opts;
  }, [projects, hasSandbox]);

  const resolveTarget = useCallback(
    (optionId: string): TerminalSpawnTarget | null => {
      if (optionId === HOST_OPTION_ID) return { kind: 'host' };
      if (optionId === SANDBOX_OPTION_ID) {
        return { kind: 'sandbox', sessionId: companySessionId };
      }
      if (optionId.startsWith(PROJECT_OPTION_PREFIX)) {
        const projectId = Number(optionId.slice(PROJECT_OPTION_PREFIX.length));
        if (Number.isFinite(projectId)) return { kind: 'project', projectId };
      }
      return null;
    },
    [companySessionId],
  );

  const spawnWith = useCallback(
    async (optionId: string, shellOverride?: { file: string; args?: string[] }) => {
      if (busy) return;
      const target = resolveTarget(optionId);
      if (!target) {
        setSpawnError(`Unknown spawn target: ${optionId}`);
        return;
      }
      setBusy(true);
      setSpawnError(null);
      try {
        const shell = shellOverride ?? activeShell ?? undefined;
        const spawn = await apiCall<SpawnResult>('terminal.spawn', {
          target,
          cols: 80,
          rows: 24,
          shell: shell?.file,
          shellArgs: shell?.args,
        });
        addSession(scope, spawn.terminalId, target, shell);
        setLastTargetId(optionId);
      } catch (err) {
        setSpawnError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [scope, busy, addSession, resolveTarget, activeShell],
  );

  /** Default "+" click — spawn against the last target the user picked. */
  const spawnDefault = useCallback(() => spawnWith(lastTargetId), [spawnWith, lastTargetId]);

  /**
   * Mount probe — same shape as WorkspaceTerminal but scoped to the
   * company session. Pruned entries don't get auto-respawned (the
   * operator may not need a terminal every visit); the empty-state CTA
   * inside the panel handles that.
   */
  const probedScopeRef = useRef<string | null>(null);
  useEffect(() => {
    if (!hasElectron) return;
    if (probedScopeRef.current === scope) return;
    probedScopeRef.current = scope;
    void (async () => {
      const initial = useTerminalSessions.getState().byScope[scope] ?? [];
      const alive: TerminalSession[] = [];
      for (const s of initial) {
        try {
          await apiCall('terminal.resize', { terminalId: s.id, cols: 80, rows: 24 });
          alive.push(s);
        } catch {
          /* drop */
        }
      }
      if (alive.length !== initial.length) {
        replaceSessions(scope, alive);
      }
    })();
  }, [scope, hasElectron, replaceSessions]);

  const closeTab = useCallback(
    async (terminalId: string) => {
      removeSession(scope, terminalId);
      try {
        await apiCall('terminal.kill', { terminalId });
      } catch {
        /* PTY may have already exited — silent */
      }
    },
    [scope, removeSession],
  );

  const restartActive = useCallback(async () => {
    if (!activeId) return;
    const current = sessions.find((s) => s.id === activeId);
    await closeTab(activeId);
    // Restart with the same target the dead tab was using; fall back
    // to the panel's last-target memory when the session lacked the
    // field (legacy persisted rows).
    const optionForCurrent = current?.target
      ? optionIdForTarget(current.target)
      : lastTargetId;
    // Reuse the dead tab's shell too, not just its target.
    await spawnWith(
      optionForCurrent,
      current?.shell ? { file: current.shell, args: current.shellArgs } : undefined,
    );
  }, [activeId, sessions, closeTab, spawnWith, lastTargetId]);

  if (!hasElectron) {
    return (
      <div className="h-full grid place-items-center text-xs text-muted-foreground gap-2 p-3">
        <AlertCircle className="h-4 w-4" />
        <span>Terminal requer o app Electron — fallback no browser não disponível.</span>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <TerminalTabBar
        sessions={sessions}
        activeId={activeId}
        onSelect={(id) => setActive(scope, id)}
        onClose={(id) => void closeTab(id)}
        onAdd={() => void spawnDefault()}
        spawnOptions={spawnOptions}
        onAddWithTarget={(id) => void spawnWith(id)}
        onRestart={() => void restartActive()}
        addDisabled={busy}
        shellOptions={shells}
        activeShellId={activeShell?.id}
        onSelectShell={selectShell}
        onAddCustomShell={() => void addCustomShell()}
      />
      {spawnError && (
        <div className="px-2 py-1 text-[10px] text-red-400 border-b bg-red-500/10 shrink-0">
          {spawnError}
        </div>
      )}
      <div
        className="flex-1 min-h-0 relative"
        style={{ background: dark ? TERMINAL_SURFACE_BG.dark : TERMINAL_SURFACE_BG.light }}
      >
        {sessions.length === 0 && !busy && (
          <div className="absolute inset-0 grid place-items-center text-xs text-muted-foreground gap-2 px-6 text-center">
            <p>Nenhum terminal aberto.</p>
            <button
              type="button"
              onClick={() => void spawnDefault()}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-input hover:bg-muted transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>
                Novo terminal · {labelForOption(spawnOptions, lastTargetId)}
              </span>
            </button>
            <p className="text-[10.5px] text-muted-foreground/80">
              Use o ▾ ao lado do "+" para escolher Host, Sandbox ou um projeto.
            </p>
          </div>
        )}
        {activeId && (
          <SingleTerminal
            key={activeId}
            terminalId={activeId}
            onProcessExited={() => void closeTab(activeId)}
          />
        )}
      </div>
    </div>
  );
}

function optionIdForTarget(target: TerminalSpawnTarget): string {
  switch (target.kind) {
    case 'host':
      return HOST_OPTION_ID;
    case 'sandbox':
      return SANDBOX_OPTION_ID;
    case 'project':
      return `${PROJECT_OPTION_PREFIX}${target.projectId}`;
  }
}

function labelForOption(options: SpawnTargetOption[], id: string): string {
  return options.find((o) => o.id === id)?.label ?? 'Host';
}
