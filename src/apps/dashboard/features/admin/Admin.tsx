import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { BedrockCredentialsDialog } from './BedrockCredentialsDialog.js';
import { ChatgptConnectionDialog } from './ChatgptConnectionDialog.js';
import { ClaudeCodeConnectionDialog } from './ClaudeCodeConnectionDialog.js';
import { CopilotConnectionDialog } from './CopilotConnectionDialog.js';
import { GoogleConnectionDialog } from './GoogleConnectionDialog.js';
import { KimiCodeConnectionDialog } from './KimiCodeConnectionDialog.js';
import { EditDialog } from './EditDialog.js';
import { ProviderCard } from './ProviderCard.js';
import { McpServersPanel } from './McpServersPanel.js';
import { SkillsPanel } from './SkillsPanel.js';
import { StoragePanel } from './StoragePanel.js';
import { HydePanel } from './HydePanel.js';
import { HygienePanel } from './HygienePanel.js';
import { ToolsPanel } from './ToolsPanel.js';
import { AuthPanel } from './AuthPanel.js';
import { GeneralAiPanel } from './GeneralAiPanel.js';
import { ChromeServicePanel } from './ChromeServicePanel.js';
import { VerdaccioPanel } from './VerdaccioPanel.js';
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
    setModelEffort,
    setSubagentTarget,
    setKimiCodeThinkingMode,
    setFallback,
  } = useAdminProviders();

  const [editing, setEditing] = useState<Partial<AdminProvider> | null>(null);
  const [bedrockOpen, setBedrockOpen] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('admin:title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('admin:description')}
        </p>
      </div>

      <Tabs defaultValue="providers">
        <TabsList>
          <TabsTrigger value="providers">{t('admin:tabs.providers')}</TabsTrigger>
          <TabsTrigger value="storage">{t('admin:tabs.embeddings')}</TabsTrigger>
          <TabsTrigger value="hygiene">Higiene</TabsTrigger>
          <TabsTrigger value="search">{t('admin:tabs.search')}</TabsTrigger>
          <TabsTrigger value="tools">{t('admin:tabs.tools')}</TabsTrigger>
          <TabsTrigger value="mcp-servers">{t('admin:tabs.mcpServers')}</TabsTrigger>
          <TabsTrigger value="skills">{t('admin:tabs.skills')}</TabsTrigger>
          <TabsTrigger value="ai-geral">IA Geral</TabsTrigger>
          <TabsTrigger value="chrome-service">Chrome Service</TabsTrigger>
          <TabsTrigger value="verdaccio">Verdaccio</TabsTrigger>
          <TabsTrigger value="auth">{t('admin:tabs.auth')}</TabsTrigger>
        </TabsList>

        <TabsContent value="providers" className="space-y-4">
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" onClick={() => setCopilotOpen(true)}>
              {t('admin:connectCopilot')}
            </Button>
            <Button variant="outline" onClick={() => setClaudeCodeOpen(true)}>
              {t('admin:connectClaudeCode')}
            </Button>
            <Button variant="outline" onClick={() => setGoogleOpen(true)}>
              {t('admin:connectGoogle')}
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
                onConnect={p.kind === 'kimi-code' ? () => setKimiCodeOpen(true) : undefined}
                onRemove={() => remove(p.id)}
                onToggleModel={(modelId, mode, enabled) => toggleModel(p.id, modelId, mode, enabled)}
                onSetModelEffort={(modelId, mode, level) => setModelEffort(p.id, modelId, mode, level)}
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
        </TabsContent>

        <TabsContent value="storage">
          <StoragePanel />
        </TabsContent>

        <TabsContent value="hygiene">
          <HygienePanel />
        </TabsContent>

        <TabsContent value="search">
          <HydePanel />
        </TabsContent>

        <TabsContent value="tools">
          <ToolsPanel />
        </TabsContent>

        <TabsContent value="mcp-servers">
          <McpServersPanel />
        </TabsContent>

        <TabsContent value="skills">
          <SkillsPanel />
        </TabsContent>

        <TabsContent value="ai-geral">
          <GeneralAiPanel />
        </TabsContent>

        <TabsContent value="chrome-service">
          <ChromeServicePanel />
        </TabsContent>

        <TabsContent value="verdaccio">
          <VerdaccioPanel />
        </TabsContent>

        <TabsContent value="auth">
          <AuthPanel />
        </TabsContent>
      </Tabs>

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
          onClose={() => setClaudeCodeOpen(false)}
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
