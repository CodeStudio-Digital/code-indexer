import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { BedrockCredentialsDialog } from './BedrockCredentialsDialog.js';
import { ChatgptConnectionDialog } from './ChatgptConnectionDialog.js';
import { CopilotConnectionDialog } from './CopilotConnectionDialog.js';
import { EditDialog } from './EditDialog.js';
import { ProviderCard } from './ProviderCard.js';
import { McpServersPanel } from './McpServersPanel.js';
import { SkillsPanel } from './SkillsPanel.js';
import { StoragePanel } from './StoragePanel.js';
import { ToolsPanel } from './ToolsPanel.js';
import { useAdminProviders } from './hooks/useAdminProviders.js';
import type { AdminProvider } from './types.js';

export default function Admin() {
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
  } = useAdminProviders();

  const [editing, setEditing] = useState<Partial<AdminProvider> | null>(null);
  const [bedrockOpen, setBedrockOpen] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [chatgptOpen, setChatgptOpen] = useState(false);

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
        <h1 className="text-2xl font-semibold">Admin</h1>
        <p className="text-sm text-muted-foreground">
          Configure providers, embeddings, and vector stores that power indexing, search, and the coder agent.
        </p>
      </div>

      <Tabs defaultValue="providers">
        <TabsList>
          <TabsTrigger value="providers">Providers &amp; Models</TabsTrigger>
          <TabsTrigger value="storage">Embeddings &amp; Vector Stores</TabsTrigger>
          <TabsTrigger value="tools">Tools</TabsTrigger>
          <TabsTrigger value="mcp-servers">MCP Servers</TabsTrigger>
          <TabsTrigger value="skills">Skills</TabsTrigger>
        </TabsList>

        <TabsContent value="providers" className="space-y-4">
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" onClick={() => setCopilotOpen(true)}>
              Connect Copilot
            </Button>
            <Button variant="outline" onClick={() => setChatgptOpen(true)}>
              Connect ChatGPT
            </Button>
            <Button variant="outline" onClick={() => setBedrockOpen(true)}>
              AWS Bedrock
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
              <Plus className="h-4 w-4 mr-2" /> Add Provider
            </Button>
          </div>

          {loading && <div className="text-sm text-muted-foreground">Loading…</div>}

          <div className="grid gap-3">
            {providers.map((p) => (
              <ProviderCard
                key={p.id}
                provider={p}
                isExpanded={expanded === p.id}
                models={models[p.id] ?? []}
                testResult={testResults[p.id]}
                refreshing={refreshing === p.id}
                onTest={() => test(p.id)}
                onToggleExpand={async () => {
                  const next = expanded === p.id ? null : p.id;
                  setExpanded(next);
                  if (next && !models[p.id]) await loadModels(p.id);
                }}
                onRefresh={() => refresh(p.id)}
                onEdit={() => setEditing(p)}
                onRemove={() => remove(p.id)}
                onToggleModel={(modelId, mode, enabled) => toggleModel(p.id, modelId, mode, enabled)}
              />
            ))}
            {!loading && providers.length === 0 && (
              <div className="text-sm text-muted-foreground border rounded-lg p-6 text-center">
                No providers configured yet. Click "Add Provider" to get started.
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="storage">
          <StoragePanel />
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
