/**
 * Non-modal consent banner: "Install PHP support (Intelephense, ~25 MB)?"
 * Shown over the project editor when detection or the active file identifies
 * a tier-1 LSP server that isn't installed yet. Downloads happen
 * ONLY from the button here (or the admin panel) — never automatically.
 * "Not now" snoozes per language (localStorage).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Loader2, Settings2, X } from 'lucide-react';
import { apiCall, apiStream, electronApi } from '../../../lib/api-client.js';
import { languageIdForPath } from '@mcp/shared/utils/language-id.js';
import type { Project } from '@mcp/shared/types.js';
import type { DetectedRunners, LspInstallFrame, LspServerStatus } from '@mcp/api-bus';
import { useTranslation } from 'react-i18next';
import { useWorkspaceStore } from '../../../state/workspace.js';
import { ProjectSettingsModal } from '../../project/settings/ProjectSettingsModal.js';
import { projectLspLanguages } from './project-lsp-detection.js';
import { AngularProfilePrompt } from './AngularProfilePrompt.js';
import { lspRuntimeGate } from './lsp-runtime-gate.js';

const SNOOZE_KEY = 'mcp-ide:lsp-install-snooze';
const SNOOZE_MS = 7 * 24 * 60 * 60_000;

function snoozed(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? '{}') as Record<string, number>; } catch { return {}; }
}
function snooze(key: string): void {
  localStorage.setItem(SNOOZE_KEY, JSON.stringify({ ...snoozed(), [key]: Date.now() + SNOOZE_MS }));
}
function isSnoozed(key: string): boolean {
  return (snoozed()[key] ?? 0) > Date.now();
}
function snoozeKey(projectId: number, language: string, status: LspServerStatus): string {
  const workspace = status.route?.workspaceId ?? 'project';
  const family = status.server?.familyId ?? status.server?.id ?? language;
  const profile = status.route?.profileId ?? status.server?.profileId ?? 'default';
  return `${projectId}:${workspace}:${family}:${profile}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function LspInstallPrompt({
  projectId,
  language,
  file,
}: {
  projectId: number;
  language: string;
  file?: string;
}) {
  const { t } = useTranslation('workspace');
  const [status, setStatus] = useState<LspServerStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [lastLog, setLastLog] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [runtimeSettingsOpen, setRuntimeSettingsOpen] = useState(false);
  const [openingSettings, setOpeningSettings] = useState(false);
  const dismissed = useRef(false);

  useEffect(() => {
    dismissed.current = false;
    setStatus(null);
    setError(null);
    setProject(null);
    setRuntimeSettingsOpen(false);
    setOpeningSettings(false);
    // TS/JS normally use the built-in service, but project-scoped overlays
    // (notably Angular) still need the same explicit install consent flow.
    if (language === 'plaintext') return;
    let cancelled = false;
    void apiCall<LspServerStatus>('lsp.serverStatus', { projectId, languageId: language, file })
      .then((s) => { if (!cancelled && !isSnoozed(snoozeKey(projectId, language, s))) setStatus(s); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [projectId, language, file]);

  const refreshStatus = async (): Promise<void> => {
    const next = await apiCall<LspServerStatus>('lsp.serverStatus', { projectId, languageId: language, file });
    setStatus(next);
  };

  if (!status || dismissed.current) return null;
  if (status.autoPrompt === false) return null; // admin turned the banner off
  const blockedProfile = status.state === 'needs-profile' || status.state === 'unsupported';
  const runtimeGate = lspRuntimeGate(status);
  if (status.state !== 'not-installed' && !blockedProfile && !runtimeGate && !installing && !error) return null;
  if (blockedProfile) {
    return (
      <AngularProfilePrompt
        projectId={projectId}
        status={status}
        notNowLabel={t('lspInstall.notNow')}
        onApplied={refreshStatus}
        onDismiss={() => {
          snooze(snoozeKey(projectId, language, status));
          dismissed.current = true;
          setStatus(null);
        }}
      />
    );
  }
  if (!status.server) return null;
  const server = status.server;

  const openRuntimeSettings = async (): Promise<void> => {
    if (!runtimeGate || openingSettings) return;
    setOpeningSettings(true);
    setError(null);
    try {
      setProject(await apiCall<Project>('projects.get', { id: projectId }));
      setRuntimeSettingsOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpeningSettings(false);
    }
  };

  const waitForReady = async (): Promise<void> => {
    setStatus((s) => s ? { ...s, state: 'starting' } : s);
    setLastLog(t('lspInstall.starting'));
    for (let i = 0; i < 30; i++) {
      const next = await apiCall<LspServerStatus>('lsp.serverStatus', { projectId, languageId: language, file });
      setStatus(next);
      if (next.state === 'ready' || (next.state === 'idle' && server.id === 'omnisharp')) return;
      if (next.state === 'failed') {
        throw new Error(next.reason || `${next.server?.label ?? server.label} failed to start`);
      }
      await delay(1000);
    }
    throw new Error(`${server.label} did not become ready within 30s`);
  };

  const install = async (): Promise<void> => {
    setInstalling(true);
    setError(null);
    try {
      if (electronApi()) {
        for await (const frame of apiStream<LspInstallFrame>('lsp.installServerStream', { serverId: server.id })) {
          if (frame.phase === 'log') setLastLog(frame.line);
          if (frame.phase === 'error') throw new Error(frame.message);
          if (frame.phase === 'done') break;
        }
      } else {
        await new Promise<void>((resolve, reject) => {
          const es = new EventSource(`/api/lsp/servers/${server.id}/install/stream`);
          es.addEventListener('install', (ev) => {
            const frame = JSON.parse((ev as MessageEvent).data) as LspInstallFrame;
            if (frame.phase === 'log') setLastLog(frame.line);
            if (frame.phase === 'error') { es.close(); reject(new Error(frame.message)); }
            if (frame.phase === 'done') { es.close(); resolve(); }
          });
          es.onerror = () => { es.close(); reject(new Error('install stream dropped')); };
        });
      }
      setStatus({ ...status, state: 'starting' });
      await waitForReady();
      dismissed.current = true;
      setStatus(null); // banner gone; OmniSharp may remain idle until interactive use
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <>
    <div className="pointer-events-auto w-full rounded-md border bg-card/95 shadow-md px-3 py-2 text-[12px] flex items-start gap-2">
      <Download className="h-3.5 w-3.5 text-primary mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-foreground">
          {runtimeGate && status.state === 'failed'
            ? `${server.label} requires ${runtimeGate.label}.`
            : t('lspInstall.question', { server: server.label, size: server.sizeLabel })}
        </div>
        {status.route?.projectVersion && (
          <div className="mt-1 text-muted-foreground text-[11px]">
            {t('angularProfile.versionOption', { version: status.route.projectVersion })} · {status.route.workspacePath}
            {status.route.supportTier === 'best-effort' ? ` · ${t('angularProfile.legacySupport')}` : ''}
          </div>
        )}
        {runtimeGate && (
          <div className="mt-1 text-amber-500 text-[11px]">
            {t('lspInstall.runtimeRequired', { runtime: runtimeGate.label })}
            {runtimeGate.reason ? ` — ${runtimeGate.reason}` : ''}
          </div>
        )}
        {installing && (
          <div className="mt-1 flex items-center gap-1.5 text-muted-foreground truncate">
            <Loader2 className="h-3 w-3 animate-spin shrink-0" />
            <span className="truncate font-mono text-[10.5px]">{lastLog || t('lspInstall.installing')}</span>
          </div>
        )}
        {error && <div className="mt-1 text-red-400 text-[11px]">{error}</div>}
        {!installing && (
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void (runtimeGate ? openRuntimeSettings() : install())}
              disabled={openingSettings}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-primary text-primary-foreground text-[11px] hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
            >
              {openingSettings && <Loader2 className="h-3 w-3 animate-spin" />}
              {!openingSettings && runtimeGate && <Settings2 className="h-3 w-3" />}
              {runtimeGate ? t('lspInstall.configureRuntime', { runtime: runtimeGate.label }) : t('lspInstall.install')}
            </button>
            <button
              type="button"
              onClick={() => { snooze(snoozeKey(projectId, language, status)); dismissed.current = true; setStatus(null); }}
              className="px-2 py-0.5 rounded border text-[11px] text-muted-foreground hover:bg-muted/40"
            >
              {t('lspInstall.notNow')}
            </button>
          </div>
        )}
      </div>
      <button
        type="button"
        aria-label={t('lspInstall.dismiss')}
        onClick={() => { dismissed.current = true; setStatus(null); }}
        className="text-muted-foreground/70 hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
    {project && runtimeGate && (
      <ProjectSettingsModal
        project={project}
        open={runtimeSettingsOpen}
        onOpenChange={(open) => {
          setRuntimeSettingsOpen(open);
          if (!open) void refreshStatus().catch(() => undefined);
        }}
        initialSection={runtimeGate.kind}
        onSaved={() => {
          void apiCall<Project>('projects.get', { id: projectId }).then(setProject).catch(() => undefined);
          void refreshStatus().catch(() => undefined);
        }}
      />
    )}
    </>
  );
}

/**
 * Project-level prompt host. Runner detection recognizes Maven/Gradle/.NET as
 * soon as a project opens; the active-file language remains as a fallback for
 * standalone Java/C# files and every other supported LSP language.
 */
export function ProjectLspInstallPrompts({ projectId }: { projectId: number }) {
  const activeFilePath = useWorkspaceStore((state) =>
    state.activeProjectId === projectId ? state.activeFilePath : null);
  const [detected, setDetected] = useState<DetectedRunners | null>(null);

  useEffect(() => {
    let alive = true;
    setDetected(null);
    void apiCall<DetectedRunners>('runner.detect', { projectId })
      .then((value) => { if (alive) setDetected(value); })
      .catch(() => { if (alive) setDetected(null); });
    return () => { alive = false; };
  }, [projectId]);

  const languages = useMemo(() => {
    const activeLanguage = activeFilePath ? languageIdForPath(activeFilePath) : null;
    return [...new Set([
      ...(activeLanguage ? [activeLanguage] : []),
      ...projectLspLanguages(detected),
    ])];
  }, [activeFilePath, detected]);

  if (languages.length === 0) return null;
  return (
    <div className="pointer-events-none absolute top-2 right-3 z-20 flex w-[min(28rem,calc(100%-1.5rem))] flex-col gap-2">
      {languages.map((language) => (
        <LspInstallPrompt
          key={`${language}:${activeFilePath ?? ''}`}
          projectId={projectId}
          language={language}
          file={activeFilePath && languageIdForPath(activeFilePath) === language ? activeFilePath : undefined}
        />
      ))}
    </div>
  );
}
