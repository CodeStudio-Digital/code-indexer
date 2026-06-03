import React from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, Eye, Network, Repeat, Send, Settings2, Shield, Sparkles, Square, Thermometer } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Combobox, type ComboboxOption } from '../../../components/ui/combobox.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover.js';
import { PROVIDERS } from '../constants.js';
import type { EnrichedProviderModel, ProviderOption } from '../types.js';
import { AgentPicker } from './AgentPicker.js';
import { FallbackPicker } from '../../../components/FallbackPicker.js';

type AgentId = 'explore' | 'plan' | 'build' | 'admin' | 'spec';

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
  /**
   * Simulated deepThink — orthogonal to `thinking`. When on, an auxiliary
   * cheap model (default Haiku) writes a brief pre-thought before each
   * main-model turn and the runner prefills it as a `<thinking>` block.
   * Propagates: useAgentChatState → POST /api/coder/sessions/:id/messages
   * `{deep_think: true}` → runner.opts.deepThink.
   */
  deepThink?: boolean;
  setDeepThink?: (v: boolean) => void;
  /**
   * "Describe images" — FORCE the vision fallback (image → text description
   * via the configured vision model) even when the active model can see
   * images. Auto-fallback for blind models happens regardless. Propagates:
   * AgentChat → POST /messages `{describe_images: true}` → runner.opts.describeImages.
   */
  describeImages?: boolean;
  setDescribeImages?: (v: boolean) => void;
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
  deepThink,
  setDeepThink,
  describeImages,
  setDescribeImages,
}: ComposerToolbarProps) {
  const { t } = useTranslation(['chat', 'common']);
  // Note: the Paperclip (attach), PipelinePicker, think, deepthink, and
  // cap/full icons now live in the markdown toolbar row above (passed
  // as `rightSlot` to MarkdownToolbar). This row is reserved for the
  // pickers + send button so the bottom of the composer is calmer.
  // `handleFiles` is still threaded through because the mobile popover
  // (and a future drag/drop overlay) may want it.
  void handleFiles; void selectedPipelineId; void setSelectedPipelineId; void sessionId;

  return (
    <div className="flex items-center gap-2 px-2 pb-2 flex-wrap sm:flex-wrap">
      <AgentPicker value={agent} onChange={setAgent} autoSuggestFor={autoSuggestText} />

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

      {/* Think / deepthink / cap toggles moved to the markdown toolbar
          row above (rendered by MarkdownToolbar's `rightSlot`). We keep
          the props flowing through so the mobile popover below — which
          condenses every control into one sheet on narrow viewports —
          still exposes the toggles. */}

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
        {/*<span className="text-[10px] text-muted-foreground hidden sm:inline">⌘+Enter</span>*/}

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
            {setDeepThink && (
              <button
                type="button"
                onClick={() => setDeepThink(!deepThink)}
                className={`w-full inline-flex items-center justify-center gap-2 h-8 px-3 rounded-md text-xs font-mono transition-colors ${
                  deepThink
                    ? 'bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/25 dark:text-emerald-300'
                    : 'border border-input text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
                aria-pressed={deepThink ?? false}
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>
                  {t('chat:toolbar.deepThink', { defaultValue: 'deepThink (simulated)' })}
                  {deepThink ? ' • on' : ''}
                </span>
              </button>
            )}
            {setDescribeImages && (
              <button
                type="button"
                onClick={() => setDescribeImages(!describeImages)}
                className={`w-full inline-flex items-center justify-center gap-2 h-8 px-3 rounded-md text-xs font-mono transition-colors ${
                  describeImages
                    ? 'bg-sky-500/15 text-sky-600 hover:bg-sky-500/25 dark:text-sky-300'
                    : 'border border-input text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
                aria-pressed={describeImages ?? false}
                title={t('chat:toolbar.describeImagesHint', {
                  defaultValue:
                    'Force the vision model to describe uploaded images as text (auto-applies anyway when the active model can\'t see images).',
                })}
              >
                <Eye className="h-3.5 w-3.5" />
                <span>
                  {t('chat:toolbar.describeImages', { defaultValue: 'Describe images' })}
                  {describeImages ? ' • on' : ''}
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
