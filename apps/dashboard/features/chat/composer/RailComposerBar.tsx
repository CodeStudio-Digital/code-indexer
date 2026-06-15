/**
 * Compact composer action bar for the editor Copilot rail. No markdown
 * formatting toolbar; the pickers (agent / provider / model / max-turns /
 * temperature / fallback) collapse behind a settings dialog; the Think
 * toggle is a prominent labelled pill; the session action icons
 * (attach / describe / cap / permission) stay inline via the shared
 * `ComposerActionIcons`. Send/Stop on the right.
 *
 * The textarea, attachments, slash-commands and send logic all live in the
 * parent `Composer` — this is layout only, so every function stays in sync
 * with the full chat composer.
 *
 * Pipeline mode is intentionally NOT wired in the rail (the editor host never
 * passes `setSelectedPipelineId`), so the PipelinePicker stays hidden and the
 * "Run pipeline" Send branch below is inert — pipelines live in the full Chat
 * tab, which has the runtime/progress panel.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, Network, Repeat, Send, Settings2, Square, Thermometer } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Combobox, type ComboboxOption } from '../../../components/ui/combobox.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip.js';
import { FallbackPicker } from '../../../components/FallbackPicker.js';
import { PROVIDERS } from '../constants.js';
import type { EnrichedProviderModel, ProviderOption } from '../types.js';
import { AgentPicker } from './AgentPicker.js';
import { ComposerActionIcons } from './ComposerActionIcons.js';

type AgentId = 'explore' | 'plan' | 'build' | 'admin' | 'spec' | 'api';

interface RailComposerBarProps {
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
  temperature: number | null;
  setTemperature: (v: number | null) => void;
  unrestrictedOutput: boolean;
  setUnrestrictedOutput?: (v: boolean) => void;
  fallbackProvider: string | null;
  fallbackModel: string | null;
  onFallbackChange: (provider: string | null, model: string | null) => void;
  getModelsForProvider: (providerId: string) => EnrichedProviderModel[];
  sessionId: number | null;
  selectedPipelineId: number | null;
  setSelectedPipelineId?: (v: number | null) => void;
  thinking?: boolean;
  setThinking?: (v: boolean) => void;
  supportsThinking?: boolean;
  describeImages?: boolean;
  setDescribeImages?: (v: boolean) => void;
  toolPermissionMode?: 'ask' | 'auto' | 'unrestricted';
  setToolPermissionMode?: (v: 'ask' | 'auto' | 'unrestricted') => void;
}

export function RailComposerBar(props: RailComposerBarProps) {
  const { t } = useTranslation(['chat', 'common']);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="flex items-center gap-1 px-2 pb-2 pt-1">
      {/* Settings dialog — agent + provider + model + turns + temperature + fallback. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            aria-label={t('chat:toolbar.modelSettings')}
          >
            <Settings2 className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{t('chat:toolbar.modelSettings')}</TooltipContent>
      </Tooltip>

      {/* Prominent Think pill. */}
      {props.setThinking && (
        <button
          type="button"
          onClick={() => props.setThinking?.(!props.thinking)}
          aria-pressed={props.thinking ?? false}
          className={`inline-flex items-center gap-1 h-7 px-2 rounded-md text-[11px] font-medium transition-colors ${
            props.thinking
              ? 'bg-purple-500/15 text-purple-600 dark:text-purple-300 hover:bg-purple-500/25'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted'
          }`}
          title={t('chat:toolbar.thinking', { defaultValue: 'Extended thinking' })}
        >
          <Brain className="h-3.5 w-3.5" />
          <span>{t('composer.think', { defaultValue: 'Think' })}</span>
        </button>
      )}

      {/* Shared session action icons (attach / describe / cap / permission). */}
      <ComposerActionIcons
        streaming={props.streaming}
        handleFiles={props.handleFiles}
        thinking={props.thinking}
        setThinking={props.setThinking}
        describeImages={props.describeImages}
        setDescribeImages={props.setDescribeImages}
        unrestrictedOutput={props.unrestrictedOutput}
        setUnrestrictedOutput={props.setUnrestrictedOutput}
        toolPermissionMode={props.toolPermissionMode}
        setToolPermissionMode={props.setToolPermissionMode}
        sessionId={props.sessionId}
        selectedPipelineId={props.selectedPipelineId}
        setSelectedPipelineId={props.setSelectedPipelineId}
        showThink={false}
      />

      <div className="ml-auto">
        {props.streaming ? (
          <Button onClick={props.onAbort} variant="destructive" size="sm" className="h-7">
            <Square className="h-3.5 w-3.5" /> {t('common:actions.stop')}
          </Button>
        ) : props.selectedPipelineId != null ? (
          <Button onClick={props.onSend} disabled={!props.hasInput} size="sm" variant="default" className="h-7">
            <Network className="h-3.5 w-3.5" /> {t('chat:pipelinePicker.runButton')}
          </Button>
        ) : (
          <Button onClick={props.onSend} disabled={!props.hasInput} size="sm" className="h-7">
            <Send className="h-3.5 w-3.5" /> {t('common:actions.send')}
          </Button>
        )}
      </div>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('chat:toolbar.modelSettings')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">{t('chat:toolbar.agent', { defaultValue: 'Agent' })}</label>
              <AgentPicker value={props.agent} onChange={props.setAgent} autoSuggestFor={props.autoSuggestText} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">{t('chat:toolbar.provider')}</label>
              <Combobox
                value={props.provider}
                onChange={(v) => props.onSwitchProvider(v, '')}
                options={props.providerOptions.map((p) => ({ value: p.id, label: p.label }))}
                placeholder={t('chat:toolbar.provider')}
                searchPlaceholder={t('chat:toolbar.searchProvider')}
                emptyLabel={t('chat:toolbar.noProvider')}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">{t('chat:toolbar.model')}</label>
              {props.currentProviderModels.length > 0 ? (
                <Combobox
                  value={props.model}
                  onChange={(v) => { props.setModel(v); props.onSwitchProvider(props.provider, v); }}
                  options={props.currentProviderModels.map<ComboboxOption>((m) => ({
                    value: m.mode ? `${m.id}::${m.mode}` : m.id,
                    label: m.id,
                    hint: m.mode,
                  }))}
                  placeholder={t('chat:toolbar.defaultModel')}
                  searchPlaceholder={t('chat:toolbar.searchModel')}
                  emptyLabel={t('chat:toolbar.noModel')}
                />
              ) : (
                <Input
                  type="text"
                  value={props.model}
                  onChange={(e) => props.setModel(e.target.value)}
                  onBlur={(e) => props.onSwitchProvider(props.provider, e.target.value)}
                  placeholder={PROVIDERS.find((p) => p.id === props.provider)?.defaultModel}
                  className="h-8 text-xs font-mono"
                />
              )}
            </div>
            <div className="flex gap-3">
              <div className="flex-1 space-y-1.5">
                <label className="text-xs text-muted-foreground">{t('chat:toolbar.maxTurns')}</label>
                <div className="flex items-center gap-1.5">
                  <Repeat className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <Input
                    type="number"
                    min={1}
                    max={200}
                    value={props.maxTurns ?? ''}
                    onChange={(e) => {
                      const v = e.target.value;
                      props.setMaxTurns(v === '' ? null : Math.max(1, parseInt(v, 10) || 1));
                    }}
                    placeholder="50"
                    className="h-7 text-xs font-mono px-1.5"
                  />
                </div>
              </div>
              <div className="flex-1 space-y-1.5">
                <label className="text-xs text-muted-foreground">{t('chat:toolbar.temperature', { defaultValue: 'Temperature' })}</label>
                <div className="flex items-center gap-1.5">
                  <Thermometer className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <Input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={props.temperature ?? ''}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === '') { props.setTemperature(null); return; }
                      const parsed = parseFloat(v);
                      if (!Number.isFinite(parsed)) return;
                      props.setTemperature(Math.min(1, Math.max(0, parsed)));
                    }}
                    placeholder={t('chat:toolbar.temperatureAuto', { defaultValue: 'auto' })}
                    className="h-7 text-xs font-mono px-1.5"
                  />
                </div>
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">{t('chat:toolbar.fallback', { defaultValue: 'Fallback' })}</label>
              <FallbackPicker
                fallbackProvider={props.fallbackProvider}
                fallbackModel={props.fallbackModel}
                providerOptions={props.providerOptions}
                getModelsForProvider={props.getModelsForProvider}
                onChange={props.onFallbackChange}
              />
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
