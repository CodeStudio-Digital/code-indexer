/**
 * Detail view for a single Design System session.
 *
 * Tabs:
 *   - Versions    — semver list, status, "Set next bump" buttons.
 *   - Components  — atoms + page templates of the latest published version.
 *   - Docs        — markdown of the latest published version.
 *   - Storybook   — iframe of the same version's static build.
 *
 * Auto-refreshes every 5 s (versions/components change as the agents
 * work). The actual agent run is monitored in the Agents tab via the
 * parent CompanySession id — we surface a quick link to it here.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, Boxes, Filter, History, Loader2, Play, RefreshCcw, Server, Square, Upload } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import {
  abortDesignSystemRound,
  fetchVersionDocs,
  getDesignSystemSession,
  installDesignSystemMcp,
  listVersionComponents,
  reExtractDesignSystem,
  setNextBumpHint,
  startDesignSystemRound,
  storybookSrc,
  type DesignSystemComponent,
  type DesignSystemSession,
  type DesignSystemVersion,
  type DsBumpHint,
} from './design-system-api.js';

const REFRESH_INTERVAL_MS = 5_000;

type TabKey = 'versions' | 'components' | 'docs' | 'storybook';

interface Props {
  sessionId: number;
  onBack: () => void;
}

export function DesignSystemSessionView({ sessionId, onBack }: Props) {
  const [session, setSession] = useState<DesignSystemSession | null>(null);
  const [versions, setVersions] = useState<DesignSystemVersion[]>([]);
  const [latestPublished, setLatestPublished] = useState<DesignSystemVersion | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [companyStatus, setCompanyStatus] = useState<string>('idle');
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('versions');
  const [busy, setBusy] = useState(false);
  const [onlyMarked, setOnlyMarked] = useState(false);
  const [extraInstructions, setExtraInstructions] = useState('');

  async function refresh() {
    try {
      const r = await getDesignSystemSession(sessionId);
      setSession(r.session);
      setVersions(r.versions);
      setLatestPublished(r.latest_published);
      setIsRunning(r.is_running);
      setCompanyStatus(r.company_session_status);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function startRound() {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await startDesignSystemRound(session.id, {
        extra_instructions: extraInstructions.trim() || undefined,
      });
      setExtraInstructions('');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function abortRound() {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await abortDesignSystemRound(session.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function installMcp() {
    if (!session || !latestPublished) return;
    setBusy(true);
    setError(null);
    try {
      const result = await installDesignSystemMcp(session.id, latestPublished.semver);
      setError(`✓ MCP instalado com sucesso (${result.mcp_server_config_id}). Disponível em Administração › MCP Servers.`);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reExtract(file?: File) {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const result = await reExtractDesignSystem(session.id, file);
      const skipped = result.extracted.skipped.length;
      const note = result.zip_replaced ? ' (zip replaced)' : '';
      const skippedNote = skipped > 0 ? ` · skipped ${skipped} unsafe` : '';
      // Brief inline confirmation; clears on next refresh.
      setError(`✓ Re-extracted ${result.extracted.files} file(s), ${(result.extracted.bytes / 1024).toFixed(1)} KB${note}${skippedNote}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  async function setHint(hint: DsBumpHint) {
    if (!session) return;
    setBusy(true);
    try {
      const next = await setNextBumpHint(session.id, hint);
      setSession(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const filteredVersions = useMemo(() => {
    if (!onlyMarked) return versions;
    return versions.filter((v) => v.bump_kind === 'minor' || v.bump_kind === 'major' || v.bump_kind === 'initial');
  }, [versions, onlyMarked]);

  if (!session) {
    return (
      <div className="px-3 py-6 sm:px-6 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading session…
      </div>
    );
  }

  return (
    <div className="px-3 py-4 sm:px-6 sm:py-6 space-y-4">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="h-4 w-4 mr-1" /> All sessions
          </Button>
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2">
              {session.name}
              <RunningBadge isRunning={isRunning} status={companyStatus} />
            </h1>
            <div className="text-xs text-muted-foreground font-mono">
              {session.package_name} · {session.stack} · next bump:{' '}
              <span className="font-semibold">{session.next_bump_hint}</span>
            </div>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          <RefreshCcw className="h-4 w-4 mr-1" /> Refresh
        </Button>
      </header>

      {error && (
        <div className="border border-red-300 bg-red-50 text-red-800 text-sm p-3 rounded">{error}</div>
      )}

      <div className="border rounded p-3 space-y-2 bg-muted/20">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-medium">Round controls</div>
          <ReExtractMenu busy={busy || isRunning} onReExtract={(f) => void reExtract(f)} />
        </div>
        <p className="text-xs text-muted-foreground">
          Each <strong>Start round</strong> aborts any prior agent activity and spins up a fresh autonomous master that runs the pipeline (extract → components → pages → MCP → docs → storybook → publish) and exits. No human-in-loop questions.
        </p>
        <textarea
          value={extraInstructions}
          onChange={(e) => setExtraInstructions(e.target.value)}
          disabled={busy || isRunning}
          placeholder="Optional extra instructions for this round (e.g. 'add a Toast component', 'redesign Button with bigger paddings')"
          className="w-full text-sm border rounded px-2 py-1 font-mono min-h-[60px]"
        />
        <div className="flex items-center gap-2">
          {isRunning ? (
            <Button variant="outline" size="sm" onClick={() => void abortRound()} disabled={busy}>
              <Square className="h-3.5 w-3.5 mr-1" /> Abort round
            </Button>
          ) : (
            <Button size="sm" onClick={() => void startRound()} disabled={busy}>
              <Play className="h-3.5 w-3.5 mr-1" />
              {versions.length === 0 ? 'Start first round' : 'Start round'}
            </Button>
          )}
          {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground mr-1">Set next bump:</span>
        {(['patch', 'minor', 'major'] as DsBumpHint[]).map((h) => (
          <Button
            key={h}
            variant={session.next_bump_hint === h ? 'default' : 'outline'}
            size="sm"
            onClick={() => void setHint(h)}
            disabled={busy}
          >
            Build {h}
          </Button>
        ))}
        <span className="text-xs text-muted-foreground ml-2">
          The next successful round publishes a {session.next_bump_hint} bump
          {latestPublished && ` (from v${latestPublished.semver})`}.
        </span>
      </div>

      {latestPublished?.mcp_manifest_json && (
        <div className="flex items-center gap-3 border rounded p-3 bg-muted/10">
          <Server className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">MCP Server</div>
            <div className="text-xs text-muted-foreground">
              {session.mcp_server_config_id
                ? `Instalado como ${session.mcp_server_config_id} — disponível em todos os agentes de chat`
                : 'Não instalado — instale para disponibilizar as ferramentas ds_use_* aos agentes de chat'}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void installMcp()}
            disabled={busy || isRunning}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Server className="h-3.5 w-3.5 mr-1" />}
            {session.mcp_server_config_id ? 'Reinstalar MCP' : 'Instalar MCP'}
          </Button>
        </div>
      )}

      <div className="border-b flex gap-1">
        <TabButton active={tab === 'versions'} icon={<History className="h-4 w-4" />} label="Versions" onClick={() => setTab('versions')} />
        <TabButton active={tab === 'components'} icon={<Boxes className="h-4 w-4" />} label="Components" onClick={() => setTab('components')} />
        <TabButton active={tab === 'docs'} icon={<BookOpen className="h-4 w-4" />} label="Docs" onClick={() => setTab('docs')} />
        <TabButton active={tab === 'storybook'} icon={<BookOpen className="h-4 w-4" />} label="Storybook" onClick={() => setTab('storybook')} />
      </div>

      {tab === 'versions' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setOnlyMarked((v) => !v)}
              className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded border ${
                onlyMarked ? 'bg-accent border-accent-foreground/30' : 'border-muted-foreground/20'
              }`}
            >
              <Filter className="h-3 w-3" /> Only marked releases
            </button>
            <span className="text-xs text-muted-foreground">{versions.length} total</span>
          </div>
          <VersionsTable versions={filteredVersions} />
        </div>
      )}

      {tab === 'components' && (
        <ComponentsView sessionId={session.id} latestPublished={latestPublished} />
      )}

      {tab === 'docs' && (
        <DocsView sessionId={session.id} latestPublished={latestPublished} />
      )}

      {tab === 'storybook' && (
        <StorybookView sessionId={session.id} latestPublished={latestPublished} />
      )}
    </div>
  );
}

function ReExtractMenu({
  busy, onReExtract,
}: { busy: boolean; onReExtract: (file?: File) => void }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className="flex items-center gap-1">
      <input
        ref={fileRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onReExtract(f);
          if (fileRef.current) fileRef.current.value = '';
        }}
      />
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => onReExtract(undefined)}
        title="Re-extract the persisted zip into design_system/ (overwrites current files)"
      >
        <RefreshCcw className="h-3.5 w-3.5 mr-1" /> Re-extract
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => fileRef.current?.click()}
        title="Upload a new zip and re-extract"
      >
        <Upload className="h-3.5 w-3.5 mr-1" /> Replace zip
      </Button>
    </div>
  );
}

function RunningBadge({ isRunning, status }: { isRunning: boolean; status: string }) {
  if (isRunning) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border border-sky-300 bg-sky-50 text-sky-800 uppercase tracking-wider">
        <Loader2 className="h-3 w-3 animate-spin" /> running
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="text-[10px] px-2 py-0.5 rounded border border-red-300 bg-red-50 text-red-800 uppercase tracking-wider">
        error
      </span>
    );
  }
  return (
    <span className="text-[10px] px-2 py-0.5 rounded border border-zinc-300 bg-zinc-50 text-zinc-700 uppercase tracking-wider">
      idle
    </span>
  );
}

function TabButton({
  active, icon, label, onClick,
}: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-3 py-2 text-sm border-b-2 transition-colors ${
        active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
      {icon} {label}
    </button>
  );
}

function VersionsTable({ versions }: { versions: DesignSystemVersion[] }) {
  if (versions.length === 0) {
    return (
      <div className="border border-dashed rounded p-6 text-sm text-center text-muted-foreground">
        No versions yet. The master will publish v1.0.0 once the first round completes.
      </div>
    );
  }
  return (
    <div className="border rounded overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="text-left px-3 py-2">Semver</th>
            <th className="text-left px-3 py-2">Bump</th>
            <th className="text-left px-3 py-2">Status</th>
            <th className="text-left px-3 py-2">Source hash</th>
            <th className="text-left px-3 py-2">Published</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.id} className="border-t">
              <td className="px-3 py-2 font-mono">{v.semver}</td>
              <td className="px-3 py-2 text-xs">
                {v.bump_kind}{v.is_auto_bump ? ' (auto)' : ''}
              </td>
              <td className="px-3 py-2 text-xs">
                <StatusBadge status={v.status} />
                {v.error && <span className="text-red-600 ml-2 truncate">{v.error}</span>}
              </td>
              <td className="px-3 py-2 font-mono text-xs">
                {v.source_hash ? v.source_hash.slice(0, 12) : '—'}
              </td>
              <td className="px-3 py-2 text-xs text-muted-foreground">
                {v.published_at ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ status }: { status: DesignSystemVersion['status'] }) {
  const tone =
    status === 'published' ? 'border-emerald-300 bg-emerald-50 text-emerald-800' :
    status === 'building'  ? 'border-sky-300 bg-sky-50 text-sky-800' :
    status === 'failed'    ? 'border-red-300 bg-red-50 text-red-800' :
    status === 'skipped'   ? 'border-zinc-300 bg-zinc-50 text-zinc-700' :
                              'border-amber-300 bg-amber-50 text-amber-800';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[11px] uppercase tracking-wider ${tone}`}>
      {status}
    </span>
  );
}

function ComponentsView({
  sessionId, latestPublished,
}: { sessionId: number; latestPublished: DesignSystemVersion | null }) {
  const [components, setComponents] = useState<DesignSystemComponent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!latestPublished) { setComponents(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        const list = await listVersionComponents(sessionId, latestPublished.semver);
        if (!cancelled) setComponents(list);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, latestPublished]);

  if (!latestPublished) {
    return <Empty>Components appear here after the first published version.</Empty>;
  }
  if (error) return <div className="text-sm text-red-600">{error}</div>;
  if (!components) return <Loading />;

  const atoms = components.filter((c) => c.kind === 'atom');
  const pages = components.filter((c) => c.kind === 'page-template');
  return (
    <div className="space-y-4">
      <Section title={`Atoms (${atoms.length})`} components={atoms} />
      <Section title={`Page templates (${pages.length})`} components={pages} />
    </div>
  );
}

function Section({ title, components }: { title: string; components: DesignSystemComponent[] }) {
  if (components.length === 0) return null;
  return (
    <div>
      <h3 className="text-sm font-semibold mb-2">{title}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {components.map((c) => (
          <div key={c.id} className="border rounded p-2 text-sm">
            <div className="font-mono">{c.name}</div>
            {c.example_code && (
              <pre className="text-xs bg-muted/40 rounded p-1 mt-1 overflow-x-auto">{c.example_code}</pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function DocsView({
  sessionId, latestPublished,
}: { sessionId: number; latestPublished: DesignSystemVersion | null }) {
  const [md, setMd] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!latestPublished) { setMd(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        const text = await fetchVersionDocs(sessionId, latestPublished.semver);
        if (!cancelled) setMd(text);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, latestPublished]);

  if (!latestPublished) return <Empty>Docs appear here after the first published version.</Empty>;
  if (error) return <div className="text-sm text-red-600">{error}</div>;
  if (md == null) return <Loading />;
  if (md.trim() === '') return <Empty>The docs-writer hasn't produced docs for this version yet.</Empty>;
  return (
    <pre className="border rounded p-3 text-sm whitespace-pre-wrap break-words bg-muted/20 max-h-[70vh] overflow-auto">
      {md}
    </pre>
  );
}

function StorybookView({
  sessionId, latestPublished,
}: { sessionId: number; latestPublished: DesignSystemVersion | null }) {
  if (!latestPublished) return <Empty>Storybook appears here after the first published version.</Empty>;
  if (!latestPublished.storybook_path) {
    return <Empty>This version was published without a Storybook build. The storybook-builder may have skipped it.</Empty>;
  }
  return (
    <iframe
      src={storybookSrc(sessionId, latestPublished.semver)}
      className="w-full border rounded"
      style={{ height: '70vh' }}
      title={`Storybook — ${latestPublished.semver}`}
    />
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-dashed rounded p-6 text-sm text-center text-muted-foreground">
      {children}
    </div>
  );
}

function Loading() {
  return (
    <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading…
    </div>
  );
}
