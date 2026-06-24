import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  ALargeSmall,
  AlertTriangle,
  AppWindow,
  Blocks,
  BookOpen,
  ChevronRight,
  Languages,
  Database,
  Gauge,
  GitFork,
  Globe,
  KeyRound,
  Network,
  Package,
  Plug,
  Plus,
  Search,
  Settings2,
  Wand2,
  Wrench,
} from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { SettingsRail } from './SettingsRail.js';
import type { GroupDef, SectionDef, SectionId } from './settings-types.js';
import { BedrockCredentialsDialog } from './BedrockCredentialsDialog.js';
import { ChatgptConnectionDialog } from './ChatgptConnectionDialog.js';
import { ClaudeCodeConnectionDialog } from './ClaudeCodeConnectionDialog.js';
import { CopilotConnectionDialog } from './CopilotConnectionDialog.js';
import { GoogleConnectionDialog } from './GoogleConnectionDialog.js';
import { KimiCodeConnectionDialog } from './KimiCodeConnectionDialog.js';
import { EditDialog } from './EditDialog.js';
import { ProviderTile } from './providers/ProviderTile.js';
import { ProviderModal } from './providers/ProviderModal.js';
import { McpServersPanel } from './McpServersPanel.js';
import { McpHttpStatusPanel } from './McpHttpStatusPanel.js';
import { AppSettingsPanel } from './AppSettingsPanel.js';
import { CapabilityFallbacksPanel } from './CapabilityFallbacksPanel.js';
import { SkillsPanel } from './SkillsPanel.js';
import { PluginsPanel } from './PluginsPanel.js';
import { StoragePanel } from './StoragePanel.js';
import { HydePanel } from './HydePanel.js';
import { HygienePanel } from './HygienePanel.js';
import { LspServersPanel } from './LspServersPanel.js';
import { ToolsPanel } from './ToolsPanel.js';
import { AuthPanel } from './AuthPanel.js';
import { AppearancePanel } from './AppearancePanel.js';
import { GeneralAiPanel } from './GeneralAiPanel.js';
import { ChromeServicePanel } from './ChromeServicePanel.js';
import { VerdaccioPanel } from './VerdaccioPanel.js';
import { PipelineBindingsPanel } from './PipelineBindingsPanel.js';
import PerfMonitorPanel from './perf/PerfMonitorPanel.js';
// PipelineTelemetryPanel / QualityPanel were moved to the `/telemetry`
// page (they're observability surfaces, not config). The Pipelines tab
// below is the only one that stays here.
import { useAdminProviders } from './hooks/useAdminProviders.js';
import type { AdminProvider } from './types.js';

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
    addModel,
    deleteModel,
    setModelEffort,
    setModelContextWindow,
    setModelMaxTools,
    backfillContextWindows,
    setSubagentTarget,
    setFallback,
  } = useAdminProviders();

  // Pre-fetch the model list for every provider so the grid tile can
  // render its "models count" badge on first paint instead of after
  // the user opens the modal. Parallel — each `loadModels` call hits
  // its own row of `provider_models`, so concurrency is safe and the
  // worst-case is N parallel cached fetches.
  useEffect(() => {
    if (!providers.length) return;
    for (const p of providers) {
      if (!models[p.id]) void loadModels(p.id);
    }
    // We intentionally don't depend on `models` — re-running on every
    // mutation would loop. Re-running on `providers` is enough to pick
    // up newly added providers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers]);

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

  // The rail is organised into fixed, always-visible groups. `groups`
  // drives header order (top → bottom: everyday model/AI tuning down to
  // system/infra); each section declares its `group` and the render
  // filters by it, so within-group order follows the `sections` array.
  const groups: GroupDef[] = [
    { id: 'models',     label: t('admin:tabs.group.models') },
    { id: 'knowledge',  label: t('admin:tabs.group.knowledge') },
    { id: 'extensions', label: t('admin:tabs.group.extensions') },
    { id: 'services',   label: t('admin:tabs.group.services') },
    { id: 'system',     label: t('admin:tabs.group.system') },
  ];

  const sections: SectionDef[] = [
    // Modelos & IA
    { id: 'providers',         label: t('admin:tabs.providers'),  icon: Plug,          group: 'models',
      hint: 'Conexões com modelos (OpenAI, Anthropic, …)' },
    { id: 'pipeline-bindings', label: 'Pipelines',                icon: GitFork,       group: 'models',
      hint: 'Bindings de provider/model por pipeline' },
    { id: 'capabilities',      label: 'Capabilities',             icon: AlertTriangle, group: 'models',
      hint: 'Modelos rodando em fallback de context window' },
    { id: 'ai-geral',          label: 'IA Geral',                 icon: Activity,      group: 'models',
      hint: 'Quality watchdog, intervention policies' },
    // Busca & Conhecimento
    { id: 'storage',           label: t('admin:tabs.embeddings'), icon: Database,      group: 'knowledge',
      hint: 'Embeddings, vector store, índices' },
    { id: 'search',            label: t('admin:tabs.search'),     icon: Search,        group: 'knowledge',
      hint: 'HyDE, reranking, configuração de busca' },
    { id: 'hygiene',           label: 'Higiene',                  icon: Wand2,         group: 'knowledge',
      hint: 'Limpeza de dados órfãos, reconciliação' },
    // Ferramentas & Extensões
    { id: 'tools',             label: t('admin:tabs.tools'),      icon: Wrench,        group: 'extensions',
      hint: 'Ferramentas internas do coder' },
    { id: 'skills',            label: t('admin:tabs.skills'),     icon: BookOpen,      group: 'extensions',
      hint: 'Skills (custom + builtin)' },
    { id: 'plugins',           label: 'Plugins',                  icon: Blocks,        group: 'extensions',
      hint: 'Instalar/gerenciar plugins + navegar o Market' },
    { id: 'mcp-servers',       label: t('admin:tabs.mcpServers'), icon: Network,       group: 'extensions',
      hint: 'Servidores MCP externos conectados' },
    { id: 'mcp-http',          label: 'MCP HTTP',                 icon: Globe,         group: 'extensions',
      hint: 'Expor nossas tools (incl. RAG) pra outros agentes' },
    // Serviços
    { id: 'lsp-servers',       label: 'Language Servers',         icon: Languages,     group: 'services',
      hint: 'LSP por linguagem (PHP, Python, …) — instalar/gerenciar' },
    { id: 'chrome-service',    label: 'Chrome Service',           icon: AppWindow,     group: 'services',
      hint: 'Browser headless pra docs / web tools' },
    { id: 'verdaccio',         label: 'Verdaccio',                icon: Package,       group: 'services',
      hint: 'Registry npm embarcado pra Design System' },
    // Sistema
    { id: 'app-settings',      label: 'Configurações',            icon: Settings2,     group: 'system',
      hint: 'Env vars persistidas: limites, flags, tuning' },
    { id: 'perf',              label: t('admin:perf.tabLabel'),   icon: Gauge,         group: 'system',
      hint: t('admin:perf.hint') },
    { id: 'auth',              label: t('admin:tabs.auth'),       icon: KeyRound,      group: 'system',
      hint: 'OAuth 2.1, API tokens, audit log' },
    { id: 'appearance',        label: t('admin:tabs.appearance'), icon: ALargeSmall,   group: 'system',
      hint: t('admin:appearance.subtitle') },
  ];

  const active = sections.find((s) => s.id === section) ?? sections[0];

  return (
    // Full-height IDE-style shell: rail + content scroll independently.
    // `/admin` opts out of AppShell's outer scroll+padding (see AppShell),
    // so this owns the height and padding. `min-h-0` on flex children is
    // load-bearing — without it the inner `overflow-y-auto` never engages.
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-1 min-h-0">
        {/* Left rail — searchable, collapsible settings tree. Scrolls
            independently of the content pane. */}
        <aside className="w-56 shrink-0 border-r overflow-y-auto bg-card/40">
          <SettingsRail
            sections={sections}
            groups={groups}
            activeId={section}
            onSelect={setSection}
          />
        </aside>

        {/* Content pane — fixed breadcrumb header + scrolling body. */}
        <section className="flex-1 min-w-0 flex flex-col min-h-0">
          <div className="flex items-center gap-1.5 px-6 py-3 border-b shrink-0 text-sm">
            <span className="text-muted-foreground">{t('admin:title')}</span>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
            <active.icon className="h-4 w-4 text-primary shrink-0" />
            <span className="font-semibold truncate">{active.label}</span>
            {active.hint && (
              <span className="text-[11.5px] text-muted-foreground hidden md:inline truncate">
                · {active.hint}
              </span>
            )}
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
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

              {/* Grid de tiles quadrados — flex-wrap pra quebra automática.
                  Click no tile abre `ProviderModal` (renderizado abaixo do
                  grid) com todos os controles avançados do provider. A
                  contagem de modelos no badge precisa ter sido carregada
                  ao menos uma vez — fazemos lazy-load no primeiro hover/
                  open. Pra o badge inicial, `models[p.id]` pode ser
                  `undefined`; nesse caso o tile mostra `?`. */}
              <div className="flex flex-wrap gap-3">
                {providers.map((p) => {
                  const known = models[p.id];
                  return (
                    <ProviderTile
                      key={p.id}
                      provider={p}
                      modelCount={known ? known.length : null}
                      testResult={testResults[p.id]}
                      onOpen={async () => {
                        setExpanded(p.id);
                        if (!known) await loadModels(p.id);
                      }}
                    />
                  );
                })}
                {!loading && providers.length === 0 && (
                  <div className="text-sm text-muted-foreground border rounded-lg p-6 text-center w-full">
                    {t('admin:noProviders')}
                  </div>
                )}
              </div>

              <ProviderModal
                provider={expanded ? (providers.find((p) => p.id === expanded) ?? null) : null}
                allProviders={providers}
                models={expanded ? (models[expanded] ?? []) : []}
                providerModelsById={models}
                testResult={expanded ? testResults[expanded] : undefined}
                refreshing={refreshing === expanded}
                onClose={() => setExpanded(null)}
                onTest={() => expanded && test(expanded)}
                onLoadProviderModels={loadModels}
                onRefresh={() => expanded && refresh(expanded)}
                onEdit={() => {
                  const p = providers.find((x) => x.id === expanded);
                  if (p) setEditing(p);
                }}
                onConnect={(() => {
                  const p = providers.find((x) => x.id === expanded);
                  if (!p) return undefined;
                  if (p.kind === 'kimi-code') return () => setKimiCodeOpen(true);
                  if (p.kind === 'claude-code') {
                    return () => {
                      setClaudeCodeProviderId(p.id);
                      setClaudeCodeOpen(true);
                    };
                  }
                  return undefined;
                })()}
                onRemove={() => {
                  if (!expanded) return;
                  void remove(expanded);
                  setExpanded(null);
                }}
                onToggleModel={(modelId, mode, enabled) =>
                  expanded && toggleModel(expanded, modelId, mode, enabled)
                }
                onAddModel={(input) => expanded && addModel(expanded, input)}
                onDeleteModel={(modelId, mode) => expanded && deleteModel(expanded, modelId, mode)}
                onSetModelEffort={(modelId, mode, level) =>
                  expanded && setModelEffort(expanded, modelId, mode, level)
                }
                onSetModelContextWindow={(modelId, mode, value) =>
                  expanded && setModelContextWindow(expanded, modelId, mode, value)
                }
                onSetModelMaxTools={(modelId, mode, value) => expanded && setModelMaxTools(expanded, modelId, mode, value)}
                onBackfillContextWindows={backfillContextWindows}
                onSetFallback={setFallback}
                onSetSubagentTarget={setSubagentTarget}
              />
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
          {section === 'plugins'           && <PluginsPanel />}
          {section === 'ai-geral'          && <GeneralAiPanel />}
          {section === 'lsp-servers'       && <LspServersPanel />}
          {section === 'chrome-service'    && <ChromeServicePanel />}
          {section === 'verdaccio'         && <VerdaccioPanel />}
          {section === 'pipeline-bindings' && <PipelineBindingsPanel />}
          {section === 'perf'              && <PerfMonitorPanel />}
          {section === 'auth'              && <AuthPanel />}
          {section === 'appearance'        && <AppearancePanel />}
          </div>
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
