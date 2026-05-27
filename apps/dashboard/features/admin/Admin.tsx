import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  AlertTriangle,
  AppWindow,
  BookOpen,
  Database,
  GitFork,
  Globe,
  KeyRound,
  Network,
  Package,
  Plug,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Wand2,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { cn } from '../../lib/utils.js';
import { BedrockCredentialsDialog } from './BedrockCredentialsDialog.js';
import { ChatgptConnectionDialog } from './ChatgptConnectionDialog.js';
import { ClaudeCodeConnectionDialog } from './ClaudeCodeConnectionDialog.js';
import { CopilotConnectionDialog } from './CopilotConnectionDialog.js';
import { GoogleConnectionDialog } from './GoogleConnectionDialog.js';
import { KimiCodeConnectionDialog } from './KimiCodeConnectionDialog.js';
import { EditDialog } from './EditDialog.js';
import { ProviderCard } from './ProviderCard.js';
import { McpServersPanel } from './McpServersPanel.js';
import { McpHttpStatusPanel } from './McpHttpStatusPanel.js';
import { AppSettingsPanel } from './AppSettingsPanel.js';
import { CapabilityFallbacksPanel } from './CapabilityFallbacksPanel.js';
import { SkillsPanel } from './SkillsPanel.js';
import { StoragePanel } from './StoragePanel.js';
import { HydePanel } from './HydePanel.js';
import { HygienePanel } from './HygienePanel.js';
import { ToolsPanel } from './ToolsPanel.js';
import { AuthPanel } from './AuthPanel.js';
import { GeneralAiPanel } from './GeneralAiPanel.js';
import { DeepThinkPanel } from './DeepThinkPanel.js';
import { ChromeServicePanel } from './ChromeServicePanel.js';
import { VerdaccioPanel } from './VerdaccioPanel.js';
import { PipelineBindingsPanel } from './PipelineBindingsPanel.js';
// PipelineTelemetryPanel / QualityPanel were moved to the `/telemetry`
// page (they're observability surfaces, not config). The Pipelines tab
// below is the only one that stays here.
import { useAdminProviders } from './hooks/useAdminProviders.js';
import type { AdminProvider } from './types.js';

type SectionId =
  | 'providers'
  | 'capabilities'
  | 'app-settings'
  | 'storage'
  | 'hygiene'
  | 'search'
  | 'tools'
  | 'mcp-servers'
  | 'mcp-http'
  | 'skills'
  | 'ai-geral'
  | 'deepthink'
  | 'chrome-service'
  | 'verdaccio'
  | 'pipeline-bindings'
  | 'auth';

interface SectionDef {
  id: SectionId;
  label: string;
  icon: LucideIcon;
  /** Optional descriptor — surfaces as muted-fg sub-text under each rail
   *  row so the user knows what the section covers without clicking. */
  hint?: string;
}

export default function Admin() {
  const { t } = useTranslation(['admin', 'common']);
  const {
    providers,
    loading,
    models,
    expanded,
    setExpanded,
    testResults,
    refreshing,
    load,
    loadModels,
    save,
    remove,
    test,
    refresh,
    toggleModel,
    setModelEffort,
    setModelContextWindow,
    backfillContextWindows,
    setSubagentTarget,
    setKimiCodeThinkingMode,
    setFallback,
  } = useAdminProviders();

  const [section, setSection] = useState<SectionId>('providers');
  const [editing, setEditing] = useState<Partial<AdminProvider> | null>(null);
  const [bedrockOpen, setBedrockOpen] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [claudeCodeProviderId, setClaudeCodeProviderId] = useState<string | null>(null);
  const [claudeCodeOpen, setClaudeCodeOpen] = useState(false);
  const [chatgptOpen, setChatgptOpen] = useState(false);
  const [googleOpen, setGoogleOpen] = useState(false);
  const [kimiCodeOpen, setKimiCodeOpen] = useState(false);

  const handleConnected = async (providerId?: string) => {
    await load();
    if (providerId) {
      setExpanded(providerId);
      await loadModels(providerId);
    }
  };

  // Sections are grouped visually by separator inside the rail. Order
  // follows usage frequency: providers/storage first (everyday tuning),
  // then search/tools/integrations, then advanced/system at the bottom.
  const sections: SectionDef[] = [
    { id: 'providers',         label: t('admin:tabs.providers'),  icon: Plug,
      hint: 'Conexões com modelos (OpenAI, Anthropic, …)' },
    { id: 'capabilities',      label: 'Capabilities',             icon: AlertTriangle,
      hint: 'Modelos rodando em fallback de context window' },
    { id: 'app-settings',      label: 'Configurações',            icon: Settings2,
      hint: 'Env vars persistidas: limites, flags, tuning' },
    { id: 'storage',           label: t('admin:tabs.embeddings'), icon: Database,
      hint: 'Embeddings, vector store, índices' },
    { id: 'hygiene',           label: 'Higiene',                  icon: Wand2,
      hint: 'Limpeza de dados órfãos, reconciliação' },
    { id: 'search',            label: t('admin:tabs.search'),     icon: Search,
      hint: 'HyDE, reranking, configuração de busca' },
    { id: 'tools',             label: t('admin:tabs.tools'),      icon: Wrench,
      hint: 'Ferramentas internas do coder' },
    { id: 'mcp-servers',       label: t('admin:tabs.mcpServers'), icon: Network,
      hint: 'Servidores MCP externos conectados' },
    { id: 'mcp-http',          label: 'MCP HTTP',                 icon: Globe,
      hint: 'Expor nossas tools (incl. RAG) pra outros agentes' },
    { id: 'skills',            label: t('admin:tabs.skills'),     icon: BookOpen,
      hint: 'Skills (custom + builtin)' },
    { id: 'ai-geral',          label: 'IA Geral',                 icon: Activity,
      hint: 'Quality watchdog, intervention policies' },
    { id: 'deepthink',         label: 'deepThink',                icon: Sparkles,
      hint: 'Modelo auxiliar de pré-pensamento' },
    { id: 'chrome-service',    label: 'Chrome Service',           icon: AppWindow,
      hint: 'Browser headless pra docs / web tools' },
    { id: 'verdaccio',         label: 'Verdaccio',                icon: Package,
      hint: 'Registry npm embarcado pra Design System' },
    { id: 'pipeline-bindings', label: 'Pipelines',                icon: GitFork,
      hint: 'Bindings de provider/model por pipeline' },
    { id: 'auth',              label: t('admin:tabs.auth'),       icon: KeyRound,
      hint: 'OAuth 2.1, API tokens, audit log' },
  ];

  const active = sections.find((s) => s.id === section) ?? sections[0];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('admin:title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('admin:description')}
        </p>
      </div>

      <div className="flex gap-6">
        {/* Left rail — list of settings sections. Each row is a single
            line: icon + label + (when active) accent bar. The section
            hint moved to a `title` tooltip + a strip above the content
            area, so the rail itself stays compact. Sticky so the rail
            stays in view when the content area scrolls (large panels
            like Providers can be tall). */}
        <aside className="w-52 shrink-0">
          <nav
            aria-label="Settings sections"
            className="sticky top-0 flex flex-col gap-0.5 border rounded-md bg-card/40 p-1"
          >
            {sections.map((def) => {
              const Icon = def.icon;
              const isActive = section === def.id;
              return (
                <button
                  key={def.id}
                  type="button"
                  onClick={() => setSection(def.id)}
                  aria-current={isActive ? 'page' : undefined}
                  title={def.hint}
                  className={cn(
                    'relative text-left rounded-sm px-2 py-1.5 transition-colors flex items-center gap-2',
                    isActive
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted',
                  )}
                >
                  {/* Active accent bar — flush against the rail edge. */}
                  {isActive && (
                    <span
                      aria-hidden
                      className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r bg-primary"
                    />
                  )}
                  <Icon
                    className={cn(
                      'h-3.5 w-3.5 shrink-0',
                      isActive ? 'text-primary' : 'text-muted-foreground/70',
                    )}
                  />
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-[12.5px] font-medium',
                      isActive ? 'text-foreground' : '',
                    )}
                  >
                    {def.label}
                  </span>
                </button>
              );
            })}
          </nav>
        </aside>

        {/* Content pane — renders the active section. The header strip
            inside shows the section label so the user has a visible
            anchor after they leave the rail (helps when the rail
            scrolls out of view on small screens / narrow windows). */}
        <section className="flex-1 min-w-0 space-y-4">
          <div className="flex items-center gap-2 pb-2 border-b">
            <active.icon className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">{active.label}</h2>
            {active.hint && (
              <span className="text-[11.5px] text-muted-foreground hidden sm:inline">
                · {active.hint}
              </span>
            )}
          </div>

          {section === 'providers' && (
            <div className="space-y-4">
              <div className="flex items-center justify-end gap-2 flex-wrap">
                <Button variant="outline" onClick={() => setCopilotOpen(true)}>
                  {t('admin:connectCopilot')}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setClaudeCodeProviderId(null);
                    setClaudeCodeOpen(true);
                  }}
                >
                  {t('admin:connectClaudeCode')}
                </Button>
                <Button variant="outline" onClick={() => setGoogleOpen(true)}>
                  <Globe className="h-4 w-4 mr-2" /> {t('admin:connectGoogle')}
                </Button>
                <Button variant="outline" onClick={() => setChatgptOpen(true)}>
                  {t('admin:connectChatgpt')}
                </Button>
                <Button variant="outline" onClick={() => setKimiCodeOpen(true)}>
                  {t('admin:connectKimiCode')}
                </Button>
                <Button variant="outline" onClick={() => setBedrockOpen(true)}>
                  {t('admin:awsBedrock')}
                </Button>
                <Button
                  onClick={() =>
                    setEditing({
                      kind: 'openai',
                      auth_mode: 'api_key',
                      enabled: true,
                      use_for_agent: true,
                      use_for_coder: true,
                    })
                  }
                >
                  <Plus className="h-4 w-4 mr-2" /> {t('admin:addProvider')}
                </Button>
              </div>

              {loading && <div className="text-sm text-muted-foreground">{t('common:actions.loading')}</div>}

              <div className="grid gap-3">
                {providers.map((p) => (
                  <ProviderCard
                    key={p.id}
                    provider={p}
                    allProviders={providers}
                    isExpanded={expanded === p.id}
                    models={models[p.id] ?? []}
                    testResult={testResults[p.id]}
                    refreshing={refreshing === p.id}
                    providerModelsById={models}
                    onTest={() => test(p.id)}
                    onToggleExpand={async () => {
                      const next = expanded === p.id ? null : p.id;
                      setExpanded(next);
                      if (next && !models[p.id]) await loadModels(p.id);
                    }}
                    onLoadProviderModels={loadModels}
                    onRefresh={() => refresh(p.id)}
                    onEdit={() => setEditing(p)}
                    onConnect={
                      p.kind === 'kimi-code'
                        ? () => setKimiCodeOpen(true)
                        : p.kind === 'claude-code'
                          ? () => {
                              setClaudeCodeProviderId(p.id);
                              setClaudeCodeOpen(true);
                            }
                          : undefined
                    }
                    onRemove={() => remove(p.id)}
                    onToggleModel={(modelId, mode, enabled) => toggleModel(p.id, modelId, mode, enabled)}
                    onSetModelEffort={(modelId, mode, level) => setModelEffort(p.id, modelId, mode, level)}
                    onSetModelContextWindow={(modelId, mode, value) => setModelContextWindow(p.id, modelId, mode, value)}
                    onBackfillContextWindows={backfillContextWindows}
                    onSetFallback={setFallback}
                    onSetSubagentTarget={setSubagentTarget}
                    onSetKimiCodeThinkingMode={setKimiCodeThinkingMode}
                  />
                ))}
                {!loading && providers.length === 0 && (
                  <div className="text-sm text-muted-foreground border rounded-lg p-6 text-center">
                    {t('admin:noProviders')}
                  </div>
                )}
              </div>
            </div>
          )}

          {section === 'capabilities'      && <CapabilityFallbacksPanel />}
          {section === 'app-settings'      && <AppSettingsPanel />}
          {section === 'storage'           && <StoragePanel />}
          {section === 'hygiene'           && <HygienePanel />}
          {section === 'search'            && <HydePanel />}
          {section === 'tools'             && <ToolsPanel />}
          {section === 'mcp-servers'       && <McpServersPanel />}
          {section === 'mcp-http'          && <McpHttpStatusPanel />}
          {section === 'skills'            && <SkillsPanel />}
          {section === 'ai-geral'          && <GeneralAiPanel />}
          {section === 'deepthink'         && <DeepThinkPanel />}
          {section === 'chrome-service'    && <ChromeServicePanel />}
          {section === 'verdaccio'         && <VerdaccioPanel />}
          {section === 'pipeline-bindings' && <PipelineBindingsPanel />}
          {section === 'auth'              && <AuthPanel />}
        </section>
      </div>

      {editing && (
        <EditDialog
          initial={editing}
          onClose={() => setEditing(null)}
          onSave={async (p) => {
            await save(p);
            setEditing(null);
          }}
        />
      )}
      {copilotOpen && (
        <CopilotConnectionDialog
          onClose={() => setCopilotOpen(false)}
          onConnected={handleConnected}
        />
      )}
      {chatgptOpen && (
        <ChatgptConnectionDialog
          onClose={() => setChatgptOpen(false)}
          onConnected={handleConnected}
        />
      )}
      {claudeCodeOpen && (
        <ClaudeCodeConnectionDialog
          providerId={claudeCodeProviderId ?? undefined}
          onClose={() => {
            setClaudeCodeOpen(false);
            setClaudeCodeProviderId(null);
          }}
          onConnected={handleConnected}
        />
      )}
      {googleOpen && (
        <GoogleConnectionDialog
          onClose={() => setGoogleOpen(false)}
          onConnected={handleConnected}
        />
      )}
      {kimiCodeOpen && (
        <KimiCodeConnectionDialog
          onClose={() => setKimiCodeOpen(false)}
          onConnected={handleConnected}
        />
      )}
      {bedrockOpen && (
        <BedrockCredentialsDialog
          onClose={() => setBedrockOpen(false)}
          onSaved={() => {
            setBedrockOpen(false);
            void load();
          }}
        />
      )}
    </div>
  );
}
