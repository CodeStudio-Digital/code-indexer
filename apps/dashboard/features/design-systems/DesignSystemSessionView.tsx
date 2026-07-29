/**
 * Detail view for a LEGACY (company-pipeline) Design System session —
 * read-only since the autonomous pipeline was retired in favour of the
 * DS Studio. Versions/Components/Docs/Storybook of published versions
 * remain browsable, and the MCP server of a published version can still
 * be (re)installed.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, BookOpen, Boxes, Filter, History, Loader2, RefreshCcw, Server } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import {
  fetchVersionDocs,
  getDesignSystemSession,
  installDesignSystemMcp,
  listVersionComponents,
  storybookSrc,
  type DesignSystemComponent,
  type DesignSystemSession,
  type DesignSystemVersion,
} from './design-system-api.js';

const REFRESH_INTERVAL_MS = 5_000;

type TabKey = 'versions' | 'components' | 'docs' | 'storybook';

interface Props {
  sessionId: string;
  onBack: () => void;
}

export function DesignSystemSessionView({ sessionId, onBack }: Props) {
  const { t } = useTranslation('designSystems');
  const [session, setSession] = useState<DesignSystemSession | null>(null);
  const [versions, setVersions] = useState<DesignSystemVersion[]>([]);
  const [latestPublished, setLatestPublished] = useState<DesignSystemVersion | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [companyStatus, setCompanyStatus] = useState<string>('idle');
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('versions');
  const [busy, setBusy] = useState(false);
  const [onlyMarked, setOnlyMarked] = useState(false);

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

  async function installMcp() {
    if (!session || !latestPublished) return;
    setBusy(true);
    setError(null);
    try {
      const result = await installDesignSystemMcp(session.id, latestPublished.semver);
      setError(`✓ ${t('session.mcpInstalledNotice', { id: result.mcp_server_config_id })}`);
      await refresh();
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

  const filteredVersions = useMemo(() => {
    if (!onlyMarked) return versions;
    return versions.filter((v) => v.bump_kind === 'minor' || v.bump_kind === 'major' || v.bump_kind === 'initial');
  }, [versions, onlyMarked]);

  if (!session) {
    return (
      <div className="px-3 py-6 sm:px-6 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('session.loading')}
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto px-3 py-4 sm:px-6 sm:py-6 space-y-4">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="h-4 w-4 mr-1" /> {t('actions.allSessions')}
          </Button>
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2">
              {session.name}
              <RunningBadge isRunning={isRunning} status={companyStatus} />
            </h1>
            <div className="text-xs text-muted-foreground font-mono">
              {session.package_name} · {session.stack}
            </div>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          <RefreshCcw className="h-4 w-4 mr-1" /> {t('actions.refresh')}
        </Button>
      </header>

      {error && (
        <div className="border border-red-300 bg-red-50 text-red-800 text-sm p-3 rounded">{error}</div>
      )}

      <div className="border rounded p-3 text-xs text-muted-foreground bg-muted/20">
        {t('legacy.readOnlyNotice')}
      </div>

      {latestPublished?.mcp_manifest_json && (
        <div className="flex items-center gap-3 border rounded p-3 bg-muted/10">
          <Server className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">{t('session.mcpTitle')}</div>
            <div className="text-xs text-muted-foreground">
              {session.mcp_server_config_id
                ? t('session.mcpInstalled', { id: session.mcp_server_config_id })
                : t('session.mcpNotInstalled')}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void installMcp()}
            disabled={busy || isRunning}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Server className="h-3.5 w-3.5 mr-1" />}
            {session.mcp_server_config_id ? t('session.reinstallMcp') : t('session.installMcp')}
          </Button>
        </div>
      )}

      <div className="border-b flex gap-1">
        <TabButton active={tab === 'versions'} icon={<History className="h-4 w-4" />} label={t('tabs.versions')} onClick={() => setTab('versions')} />
        <TabButton active={tab === 'components'} icon={<Boxes className="h-4 w-4" />} label={t('tabs.components')} onClick={() => setTab('components')} />
        <TabButton active={tab === 'docs'} icon={<BookOpen className="h-4 w-4" />} label={t('tabs.docs')} onClick={() => setTab('docs')} />
        <TabButton active={tab === 'storybook'} icon={<BookOpen className="h-4 w-4" />} label={t('tabs.storybook')} onClick={() => setTab('storybook')} />
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
              <Filter className="h-3 w-3" /> {t('versions.onlyMarked')}
            </button>
            <span className="text-xs text-muted-foreground">{t('versions.total', { count: versions.length })}</span>
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

function RunningBadge({ isRunning, status }: { isRunning: boolean; status: string }) {
  const { t } = useTranslation('designSystems');
  if (isRunning) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border border-sky-300 bg-sky-50 text-sky-800 uppercase tracking-wider">
        <Loader2 className="h-3 w-3 animate-spin" /> {t('status.running')}
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="text-[10px] px-2 py-0.5 rounded border border-red-300 bg-red-50 text-red-800 uppercase tracking-wider">
        {t('status.error')}
      </span>
    );
  }
  return (
    <span className="text-[10px] px-2 py-0.5 rounded border border-zinc-300 bg-zinc-50 text-zinc-700 uppercase tracking-wider">
      {t('status.idle')}
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
  const { t } = useTranslation('designSystems');
  if (versions.length === 0) {
    return (
      <div className="border border-dashed rounded p-6 text-sm text-center text-muted-foreground">
        {t('versions.empty')}
      </div>
    );
  }
  return (
    <div className="border rounded overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="text-left px-3 py-2">{t('versions.semver')}</th>
            <th className="text-left px-3 py-2">{t('versions.bump')}</th>
            <th className="text-left px-3 py-2">{t('table.status')}</th>
            <th className="text-left px-3 py-2">{t('versions.sourceHash')}</th>
            <th className="text-left px-3 py-2">{t('versions.published')}</th>
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
}: { sessionId: string; latestPublished: DesignSystemVersion | null }) {
  const { t } = useTranslation('designSystems');
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
    return <Empty>{t('components.empty')}</Empty>;
  }
  if (error) return <div className="text-sm text-red-600">{error}</div>;
  if (!components) return <Loading />;

  const atoms = components.filter((c) => c.kind === 'atom');
  const pages = components.filter((c) => c.kind === 'page-template');
  return (
    <div className="space-y-4">
      <Section title={t('components.atoms', { count: atoms.length })} components={atoms} />
      <Section title={t('components.pageTemplates', { count: pages.length })} components={pages} />
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
}: { sessionId: string; latestPublished: DesignSystemVersion | null }) {
  const { t } = useTranslation('designSystems');
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

  if (!latestPublished) return <Empty>{t('docs.empty')}</Empty>;
  if (error) return <div className="text-sm text-red-600">{error}</div>;
  if (md == null) return <Loading />;
  if (md.trim() === '') return <Empty>{t('docs.none')}</Empty>;
  return (
    <pre className="border rounded p-3 text-sm whitespace-pre-wrap break-words bg-muted/20 max-h-[70vh] overflow-auto">
      {md}
    </pre>
  );
}

function StorybookView({
  sessionId, latestPublished,
}: { sessionId: string; latestPublished: DesignSystemVersion | null }) {
  const { t } = useTranslation('designSystems');
  if (!latestPublished) return <Empty>{t('storybook.empty')}</Empty>;
  if (!latestPublished.storybook_path) {
    return <Empty>{t('storybook.noBuild')}</Empty>;
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
  const { t } = useTranslation('designSystems');
  return (
    <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> {t('loading')}
    </div>
  );
}
