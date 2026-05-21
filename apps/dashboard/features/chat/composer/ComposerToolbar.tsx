import React from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, Maximize2, Network, Paperclip, Repeat, Send, Settings2, Shield, Square, Thermometer } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Combobox, type ComboboxOption } from '../../../components/ui/combobox.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover.js';
import { PROVIDERS } from '../constants.js';
import type { EnrichedProviderModel, ProviderOption } from '../types.js';
import { AgentPicker } from './AgentPicker.js';
import { FallbackPicker } from '../../../components/FallbackPicker.js';
import { PipelinePicker } from './PipelinePicker.js';

type AgentId = 'explore' | 'plan' | 'build' | 'admin';

interface ComposerToolbarProps {
  hasInput: boolean;
  autoSuggestText: string;
  agent: AgentId;
  setAgent: (v: AgentId) => void;
  provider: string;
  model: string;
  setModel: (v: string) => void;
  onSwitchProvider: (p: string, m: string) => void;
  onSend: () => void;
  onAbort: () => void;
  streaming: boolean;
  handleFiles: (files: FileList | null) => Promise<void>;
  providerOptions: ProviderOption[];
  currentProviderModels: EnrichedProviderModel[];
  maxTurns: number | null;
  setMaxTurns: (v: number | null) => void;
  /**
   * Per-session temperature override. `null` = inherit (resolver falls through
   * to role/agent/default). UI clears the value back to null when the user
   * empties the input; the runtime resolver clamps to [0, 1].
   */
  temperature: number | null;
  setTemperature: (v: number | null) => void;
  /**
   * Per-session "unrestricted tool output" toggle (migration 078). When on,
   * the runner / mcp-bridge / code_exec lift the per-tool-call truncation
   * cap from ~24 KB to ~1 MB. Auto-compaction still runs.
   */
  unrestrictedOutput: boolean;
  setUnrestrictedOutput?: (v: boolean) => void;
  fallbackProvider: string | null;
  fallbackModel: string | null;
  onFallbackChange: (provider: string | null, model: string | null) => void;
  getModelsForProvider: (providerId: string) => EnrichedProviderModel[];
  /** Chat session id — needed by the PipelinePicker to scope its list. */
  sessionId: number | null;
  /** Currently-selected pipeline id, or null when not in pipeline mode. */
  selectedPipelineId: number | null;
  setSelectedPipelineId?: (v: number | null) => void;
  /**
   * Per-session extended-thinking toggle. Only rendered when the active
   * provider/model declares `supportsThinking` (see provider-caps.ts). The flag
   * propagates through useAgentChatState → POST /api/coder/sessions/:id/messages
   * → runner → ChatProvider.chat({ thinking: true }), where the provider maps
   * it to its native parameter (Anthropic extendedThinking, Gemini
   * thinkingConfig, OpenAI reasoning.effort, etc).
   */
  thinking?: boolean;
  setThinking?: (v: boolean) => void;
  supportsThinking?: boolean;
}

export const ComposerToolbar = React.memo(function ComposerToolbar({
  hasInput,
  autoSuggestText,
  agent,
  setAgent,
  provider,
  model,
  setModel,
  onSwitchProvider,
  onSend,
  onAbort,
  streaming,
  handleFiles,
  providerOptions,
  currentProviderModels,
  maxTurns,
  setMaxTurns,
  temperature,
  setTemperature,
  unrestrictedOutput,
  setUnrestrictedOutput,
  fallbackProvider,
  fallbackModel,
  onFallbackChange,
  getModelsForProvider,
  sessionId,
  selectedPipelineId,
  setSelectedPipelineId,
  thinking,
  setThinking,
  supportsThinking,
}: ComposerToolbarProps) {
  const { t } = useTranslation(['chat', 'common']);
  return (
    <div className="flex items-center gap-2 px-2 pb-2 flex-wrap sm:flex-wrap">
      <label className="cursor-pointer">
        <input
          type="file"
          multiple
          accept="image/*,.pdf,.txt,.md,.json,.csv,.yaml,.yml,.xml,.html,.ts,.tsx,.js,.jsx,.py,.go,.rs,.java,.sh,.sql,.toml,.ini,.log"
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <span className="inline-flex items-center justify-center h-8 w-8 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
          <Paperclip className="h-4 w-4" />
        </span>
      </label>

      <AgentPicker value={agent} onChange={setAgent} autoSuggestFor={autoSuggestText} />

      {setSelectedPipelineId && (
        <PipelinePicker
          sessionId={sessionId}
          selectedPipelineId={selectedPipelineId}
          onChange={setSelectedPipelineId}
        />
      )}

      <div className="hidden sm:block w-[110px]">
        <Combobox
          value={provider}
          onChange={(v) => onSwitchProvider(v, '')}
          options={providerOptions.map((p) => ({ value: p.id, label: p.label }))}
          placeholder={t('chat:toolbar.provider')}
          searchPlaceholder={t('chat:toolbar.searchProvider')}
          emptyLabel={t('chat:toolbar.noProvider')}
        />
      </div>

      {currentProviderModels.length > 0 ? (
        <div className="hidden sm:block w-40">
          <Combobox
            value={model}
            onChange={(v) => {
              setModel(v);
              onSwitchProvider(provider, v);
            }}
            options={currentProviderModels.map<ComboboxOption>((m) => ({
              value: m.mode ? `${m.id}::${m.mode}` : m.id,
              label: m.id,
              hint: m.mode,
            }))}
            placeholder={t('chat:toolbar.defaultModel')}
            searchPlaceholder={t('chat:toolbar.searchModel')}
            emptyLabel={t('chat:toolbar.noModel')}
          />
        </div>
      ) : (
        <Input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          onBlur={(e) => onSwitchProvider(provider, e.target.value)}
          placeholder={PROVIDERS.find((p) => p.id === provider)?.defaultModel}
          className="hidden sm:block h-8 w-32 text-xs font-mono"
        />
      )}

      <div className="hidden sm:flex items-center gap-1 text-muted-foreground" title={t('chat:toolbar.maxTurns')}>
        <Repeat className="h-3.5 w-3.5" />
        <Input
          type="number"
          min={1}
          max={200}
          value={maxTurns ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            setMaxTurns(v === '' ? null : Math.max(1, parseInt(v, 10) || 1));
          }}
          placeholder="50"
          className="h-7 w-16 text-xs font-mono px-1.5"
        />
      </div>

      <div
        className="hidden sm:flex items-center gap-1 text-muted-foreground"
        title={t('chat:toolbar.temperature', { defaultValue: 'Temperature override (empty = auto by agent)' })}
      >
        <Thermometer className="h-3.5 w-3.5" />
        <Input
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={temperature ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '') {
              setTemperature(null);
              return;
            }
            const parsed = parseFloat(v);
            if (!Number.isFinite(parsed)) return;
            setTemperature(Math.min(1, Math.max(0, parsed)));
          }}
          placeholder="auto"
          className="h-7 w-16 text-xs font-mono px-1.5"
        />
      </div>

      {/* Extended-thinking toggle. Only shown when the active provider/model
          declares `supportsThinking` (provider-caps.ts). Mirrors the chip
          styling of the `cap`/`full` button below for visual consistency. */}
      {supportsThinking && setThinking && (
        <button
          type="button"
          onClick={() => setThinking(!thinking)}
          className={`hidden sm:inline-flex items-center gap-1 h-7 px-2 rounded-md text-xs font-mono transition-colors ${
            thinking
              ? 'bg-purple-500/15 text-purple-600 hover:bg-purple-500/25 dark:text-purple-300'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
          title={t('chat:toolbar.thinking', {
            defaultValue:
              'Extended thinking: the model reasons step-by-step before answering. Slower and pricier on Pro/Opus tiers; quality bump on hard problems. Capped at 8K thinking tokens to avoid runaway loops.',
          })}
          aria-pressed={thinking ?? false}
        >
          <Brain className="h-3.5 w-3.5" />
          <span>{thinking ? 'think+' : 'think'}</span>
        </button>
      )}

      {/* Unrestricted-tool-output toggle (migration 078). When on, lifts the
          per-tool-call truncation cap from ~24 KB to ~1 MB so verbose MCP
          tools (Unity, large file reads, batched code_exec) arrive intact.
          Auto-compaction in the runner still runs. */}
      {setUnrestrictedOutput && (
        <button
          type="button"
          onClick={() => setUnrestrictedOutput(!unrestrictedOutput)}
          className={`hidden sm:inline-flex items-center gap-1 h-7 px-2 rounded-md text-xs font-mono transition-colors ${
            unrestrictedOutput
              ? 'bg-amber-500/15 text-amber-600 hover:bg-amber-500/25'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
          title={t('chat:toolbar.unrestrictedOutput', {
            defaultValue:
              'Tool output: full. Raises per-tool-call truncation cap to ~1 MB (default ~24 KB). Useful for Unity / large file reads. Auto-compaction still runs. Applied on the next message.',
          })}
          aria-pressed={unrestrictedOutput}
        >
          <Maximize2 className="h-3.5 w-3.5" />
          <span>{unrestrictedOutput ? 'full' : 'cap'}</span>
        </button>
      )}

      {/* Desktop fallback popover */}
      <div className="hidden sm:block">
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={`p-1.5 rounded-md hover:bg-muted transition-colors ${
                fallbackProvider
                  ? 'text-amber-500 hover:text-amber-600'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              title={fallbackProvider
                ? `Fallback: ${fallbackProvider} / ${fallbackModel ?? '?'}`
                : 'Configurar fallback'
              }
            >
              <Shield className="h-4 w-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-3" align="end" side="top">
            <FallbackPicker
              fallbackProvider={fallbackProvider}
              fallbackModel={fallbackModel}
              providerOptions={providerOptions}
              getModelsForProvider={getModelsForProvider}
              onChange={onFallbackChange}
            />
          </PopoverContent>
        </Popover>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <span className="text-[10px] text-muted-foreground hidden sm:inline">⌘+Enter</span>

        {/* Mobile-only settings popover */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="sm:hidden p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              title={t('chat:toolbar.modelSettings')}
            >
              <Settings2 className="h-4 w-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-3 space-y-3" align="end" side="top">
            <p className="text-xs font-medium text-muted-foreground">{t('chat:toolbar.modelSettings')}</p>
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground">{t('chat:toolbar.provider')}</label>
              <Combobox
                value={provider}
                onChange={(v) => onSwitchProvider(v, '')}
                options={providerOptions.map((p) => ({ value: p.id, label: p.label }))}
                placeholder="Provider"
                searchPlaceholder="Search provider…"
                emptyLabel="No provider"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground">{t('chat:toolbar.model')}</label>
              {currentProviderModels.length > 0 ? (
                <Combobox
                  value={model}
                  onChange={(v) => { setModel(v); onSwitchProvider(provider, v); }}
                  options={currentProviderModels.map<ComboboxOption>((m) => ({
                    value: m.mode ? `${m.id}::${m.mode}` : m.id,
                    label: m.id,
                    hint: m.mode,
                  }))}
                  placeholder="(default)"
                  searchPlaceholder="Search model…"
                  emptyLabel="No model"
                />
              ) : (
                <Input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  onBlur={(e) => onSwitchProvider(provider, e.target.value)}
                  placeholder={PROVIDERS.find((p) => p.id === provider)?.defaultModel}
                  className="h-8 text-xs font-mono"
                />
              )}
            </div>
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground">{t('chat:toolbar.maxTurns')}</label>
              <div className="flex items-center gap-2">
                <Repeat className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <Input
                  type="number"
                  min={1}
                  max={200}
                  value={maxTurns ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    setMaxTurns(v === '' ? null : Math.max(1, parseInt(v, 10) || 1));
                  }}
                  placeholder="50"
                  className="h-7 text-xs font-mono px-1.5"
                />
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground">
                {t('chat:toolbar.temperature', { defaultValue: 'Temperature' })}
              </label>
              <div className="flex items-center gap-2">
                <Thermometer className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={temperature ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === '') {
                      setTemperature(null);
                      return;
                    }
                    const parsed = parseFloat(v);
                    if (!Number.isFinite(parsed)) return;
                    setTemperature(Math.min(1, Math.max(0, parsed)));
                  }}
                  placeholder="auto"
                  className="h-7 text-xs font-mono px-1.5"
                />
              </div>
            </div>
            {supportsThinking && setThinking && (
              <button
                type="button"
                onClick={() => setThinking(!thinking)}
                className={`w-full inline-flex items-center justify-center gap-2 h-8 px-3 rounded-md text-xs font-mono transition-colors ${
                  thinking
                    ? 'bg-purple-500/15 text-purple-600 hover:bg-purple-500/25 dark:text-purple-300'
                    : 'border border-input text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
                aria-pressed={thinking ?? false}
              >
                <Brain className="h-3.5 w-3.5" />
                <span>
                  {t('chat:toolbar.thinking', { defaultValue: 'Extended thinking' })}
                  {thinking ? ' • on' : ''}
                </span>
              </button>
            )}
            <FallbackPicker
              fallbackProvider={fallbackProvider}
              fallbackModel={fallbackModel}
              providerOptions={providerOptions}
              getModelsForProvider={getModelsForProvider}
              onChange={onFallbackChange}
            />
          </PopoverContent>
        </Popover>

        {streaming ? (
          <Button onClick={onAbort} variant="destructive" size="sm">
            <Square className="h-3.5 w-3.5" /> {t('common:actions.stop')}
          </Button>
        ) : selectedPipelineId != null ? (
          <Button onClick={onSend} disabled={!hasInput} size="sm" variant="default">
            <Network className="h-3.5 w-3.5" /> {t('chat:pipelinePicker.runButton')}
          </Button>
        ) : (
          <Button onClick={onSend} disabled={!hasInput} size="sm">
            <Send className="h-3.5 w-3.5" /> {t('common:actions.send')}
          </Button>
        )}
      </div>
    </div>
  );
});
