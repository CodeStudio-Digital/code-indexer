/**
 * Compact composer action bar for the editor Copilot rail. Mirrors the full
 * chat composer's layout in two thin rows so the rail isn't a stripped-down
 * surface:
 *   • top strip — session action icons (attach / describe / cap / permission /
 *     mic) + the provider·model chip that opens the model settings dialog.
 *   • bottom row — the agent/mode picker (Explore / Plan / Build / …), the
 *     reasoning-effort + plan-depth selectors (same inline placement the full
 *     composer uses), a prominent Think pill, and Send/Stop.
 *
 * Deeper model config (provider / model / max-turns / temperature / fallback)
 * stays behind the chip's dialog so the narrow rail isn't crowded; the dialog
 * runs with `showAgent={false}` since the agent picker is inline here.
 *
 * The textarea, attachments, slash-commands and send logic all live in the
 * parent `Composer` — this is layout only, so every function stays in sync
 * with the full chat composer.
 *
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, Gauge, Layers, Send, Square } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip.js';
import type { EnrichedProviderModel, ExecutionMode, ProviderOption } from '../types.js';
import { AgentPicker } from './AgentPicker.js';
import { ComposerActionIcons } from './ComposerActionIcons.js';
import { ModelSettingsDialog, modelSettingsLabel } from './ModelSettingsDialog.js';
import type { OutputCapLevel } from './output-cap-levels.js';
import { QueueSplitButton } from './QueueSplitButton.js';
import type { QueueMode } from './useMessageQueue.js';
import type { AgentPreset } from '@mcp/api-bus';

type AgentId = AgentPreset;

interface RailComposerBarProps {
  hasInput: boolean;
  autoSuggestText: string;
  agent: AgentId;
  setAgent: (v: AgentId) => void;
  hideAgentPicker?: boolean;
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
  maxAutoContinues: number;
  setMaxAutoContinues: (v: number) => void;
  temperature: number | null;
  setTemperature: (v: number | null) => void;
  /** Per-session sticky reasoning-effort override (migration 150). Orthogonal
   *  to thinking; selector renders only when `reasoningLevels` is non-empty. */
  reasoningEffort?: string | null;
  setReasoningEffort?: (v: string | null) => void;
  reasoningLevels?: string[];
  executionMode?: ExecutionMode;
  setExecutionMode?: (v: ExecutionMode) => void;
  executionModePending?: boolean;
  executionModeLocked?: boolean;
  /** Per-session sticky plan-depth (migration 151): simple|normal|complex.
   *  Selector renders only while the `plan` agent is active. */
  planDepth?: string | null;
  setPlanDepth?: (v: string | null) => void;
  outputCapLevel: OutputCapLevel;
  setOutputCapLevel?: (v: OutputCapLevel) => void;
  fallbackProvider: string | null;
  fallbackModel: string | null;
  onFallbackChange: (provider: string | null, model: string | null) => void;
  getModelsForProvider: (providerId: string) => EnrichedProviderModel[];
  sessionId: string | null;
  thinking?: boolean;
  setThinking?: (v: boolean) => void;
  supportsThinking?: boolean;
  ultraControlsThinking?: boolean;
  describeImages?: boolean;
  setDescribeImages?: (v: boolean) => void;
  blockCodeComments?: boolean;
  setBlockCodeComments?: (v: boolean) => void;
  toolPermissionMode?: 'ask' | 'auto' | 'unrestricted';
  setToolPermissionMode?: (v: 'ask' | 'auto' | 'unrestricted') => void;
  /** When streaming + queueable, show the queue split button beside Stop. */
  queueable?: boolean;
  onQueueSend?: (mode: QueueMode) => void;
  sendBlocked?: boolean;
  /** Append voice-transcribed text to the composer input. */
  onTranscript?: (text: string) => void;
}

export function RailComposerBar(props: RailComposerBarProps) {
  const { t } = useTranslation(['chat', 'common']);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="flex flex-col gap-1 px-2 pb-2 pt-1">
      {/* Top strip: shared session action icons (attach / describe / cap /
          permission / mic) + the provider·model chip that opens the model
          settings dialog — mirrors the full composer's action row. */}
      <div className="flex items-center gap-0.5">
        <ComposerActionIcons
          streaming={props.streaming}
          allowAttachmentsWhileStreaming={props.queueable}
          handleFiles={props.handleFiles}
          thinking={props.thinking}
          setThinking={props.setThinking}
          thinkingManaged={props.ultraControlsThinking}
          describeImages={props.describeImages}
          setDescribeImages={props.setDescribeImages}
          blockCodeComments={props.blockCodeComments}
          setBlockCodeComments={props.setBlockCodeComments}
          outputCapLevel={props.outputCapLevel}
          setOutputCapLevel={props.setOutputCapLevel}
          toolPermissionMode={props.toolPermissionMode}
          setToolPermissionMode={props.setToolPermissionMode}
          sessionId={props.sessionId}
          showThink={false}
          onTranscript={props.onTranscript}
        />
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="ml-auto inline-flex items-center max-w-[55%] h-7 px-2 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title={t('chat:toolbar.modelSettings')}
        >
          <span className="truncate font-mono">
            {modelSettingsLabel(
              props.providerOptions,
              props.provider,
              props.model,
              t('composer.selectModel', { defaultValue: 'Select a model' }),
            )}
          </span>
          {props.executionMode === 'ultra' && (
            <span className="ml-1.5 shrink-0 font-medium text-violet-600 dark:text-violet-300">
              {t('chat:ultra.badge', { defaultValue: 'Ultra' })}
            </span>
          )}
        </button>
      </div>

      {/* Bottom row: agent/mode picker + reasoning effort + plan depth + Think
          pill + Send/Stop — same inline controls as the full composer's
          toolbar so the rail exposes the mode at a glance. */}
      <div className="flex items-center gap-1 flex-wrap">
        {!props.hideAgentPicker && (
          <AgentPicker value={props.agent} onChange={props.setAgent} autoSuggestFor={props.autoSuggestText} />
        )}

        {/* Reasoning effort — only when the model exposes discrete effort levels. */}
        {props.setReasoningEffort && props.reasoningLevels && props.reasoningLevels.length > 0 && (
          <div
            className="flex items-center gap-1 text-muted-foreground"
            title={t('chat:toolbar.effortHint', { defaultValue: 'Reasoning effort (auto = model default)' })}
          >
            <Gauge className="h-3.5 w-3.5 shrink-0" />
            <select
              aria-label={t('chat:toolbar.effort', { defaultValue: 'Reasoning effort' })}
              className="h-7 rounded border bg-background px-1.5 text-xs"
              value={props.reasoningEffort ?? ''}
              disabled={false}
              onChange={(e) => props.setReasoningEffort?.(e.target.value === '' ? null : e.target.value)}
            >
              <option value="">{t('chat:toolbar.effortAuto', { defaultValue: 'auto' })}</option>
              {props.reasoningLevels.map((lv) => (
                <option key={lv} value={lv}>
                  {lv}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Plan depth — only while the `plan` agent is active. */}
        {props.agent === 'plan' && props.setPlanDepth && (
          <div
            className="flex items-center gap-1 text-muted-foreground"
            title={t('chat:toolbar.planDepthHint', { defaultValue: 'Plan depth — how deep the planning agent goes' })}
          >
            <Layers className="h-3.5 w-3.5 shrink-0" />
            <select
              aria-label={t('chat:toolbar.planDepth', { defaultValue: 'Plan depth' })}
              className="h-7 rounded border bg-background px-1.5 text-xs"
              value={props.planDepth ?? 'normal'}
              onChange={(e) => props.setPlanDepth?.(e.target.value)}
            >
              <option value="simple">{t('chat:toolbar.planDepthSimple', { defaultValue: 'Simple' })}</option>
              <option value="normal">{t('chat:toolbar.planDepthNormal', { defaultValue: 'Normal' })}</option>
              <option value="complex">{t('chat:toolbar.planDepthComplex', { defaultValue: 'Complex' })}</option>
            </select>
          </div>
        )}

        {/* Prominent Think pill. */}
        {(props.supportsThinking || props.ultraControlsThinking) && props.setThinking && (
          <button
            type="button"
            onClick={() => props.setThinking?.(!props.thinking)}
            aria-pressed={props.ultraControlsThinking || (props.thinking ?? false)}
            disabled={props.ultraControlsThinking}
            className={`inline-flex items-center gap-1 h-7 px-2 rounded-md text-[11px] font-medium transition-colors ${
              props.ultraControlsThinking || props.thinking
                ? 'bg-purple-500/15 text-purple-600 dark:text-purple-300 hover:bg-purple-500/25'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            } disabled:opacity-60 disabled:cursor-not-allowed`}
            title={props.ultraControlsThinking
              ? t('chat:ultra.thinkingManaged', { defaultValue: 'Ultra controls reasoning for this model. Your Think preference is preserved for Standard mode.' })
              : t('chat:toolbar.thinking', { defaultValue: 'Extended thinking' })}
          >
            <Brain className="h-3.5 w-3.5" />
            <span>{t('composer.think', { defaultValue: 'Think' })}</span>
          </button>
        )}

        <div className="ml-auto flex items-center gap-1">
          {props.streaming ? (
            <>
              {props.queueable && props.onQueueSend && (
                <QueueSplitButton hasInput={props.hasInput} onQueue={props.onQueueSend} compact />
              )}
              <Button onClick={props.onAbort} variant="destructive" size="sm" className="h-7">
                <Square className="h-3.5 w-3.5" /> {t('common:actions.stop')}
              </Button>
            </>
          ) : (
            <Button onClick={props.onSend} disabled={!props.hasInput || props.sendBlocked} size="sm" className="h-7">
              <Send className="h-3.5 w-3.5" /> {t('common:actions.send')}
            </Button>
          )}
        </div>
      </div>

      <ModelSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        showAgent={false}
        agent={props.agent}
        setAgent={props.setAgent}
        autoSuggestText={props.autoSuggestText}
        provider={props.provider}
        model={props.model}
        setModel={props.setModel}
        onSwitchProvider={props.onSwitchProvider}
        providerOptions={props.providerOptions}
        currentProviderModels={props.currentProviderModels}
        maxTurns={props.maxTurns}
        setMaxTurns={props.setMaxTurns}
        maxAutoContinues={props.maxAutoContinues}
        setMaxAutoContinues={props.setMaxAutoContinues}
        temperature={props.temperature}
        setTemperature={props.setTemperature}
        reasoningEffort={props.reasoningEffort}
        setReasoningEffort={props.setReasoningEffort}
        reasoningLevels={props.reasoningLevels}
        executionMode={props.executionMode}
        setExecutionMode={props.setExecutionMode}
        executionModePending={props.executionModePending}
        executionModeLocked={props.executionModeLocked}
        planDepth={props.planDepth}
        setPlanDepth={props.setPlanDepth}
        fallbackProvider={props.fallbackProvider}
        fallbackModel={props.fallbackModel}
        onFallbackChange={props.onFallbackChange}
        getModelsForProvider={props.getModelsForProvider}
      />
    </div>
  );
}
