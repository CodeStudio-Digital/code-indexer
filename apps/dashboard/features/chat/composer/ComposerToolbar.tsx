/**
 * Bottom row of the full chat composer: the agent picker (left) + the
 * send / stop / run-pipeline button (right). The model-scoped pickers
 * (provider / model / turns / temperature / reasoning / plan-depth /
 * fallback) moved behind the `ModelSettingsDialog`, opened from a text chip
 * in the action-icons strip above — keeping this row calm.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Gauge, Layers, Network, Send, Square } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { AgentPicker } from './AgentPicker.js';
import { QueueSplitButton } from './QueueSplitButton.js';
import type { QueueMode } from './useMessageQueue.js';

type AgentId = 'explore' | 'plan' | 'build' | 'admin' | 'spec' | 'app_spec' | 'app_db' | 'app_architect' | 'api' | 'diagram' | 'builder';

interface ComposerToolbarProps {
  hasInput: boolean;
  autoSuggestText: string;
  agent: AgentId;
  setAgent: (v: AgentId) => void;
  /** Guided surfaces (App Studio) hide the picker — the session is agent-locked. */
  hideAgentPicker?: boolean;
  onSend: () => void;
  onAbort: () => void;
  streaming: boolean;
  /**
   * Reasoning effort + plan depth stay inline next to the agent picker
   * (icon + select + tooltip). Reasoning renders only when the model exposes
   * discrete effort levels; plan depth only while the `plan` agent is active.
   */
  reasoningEffort?: string | null;
  setReasoningEffort?: (v: string | null) => void;
  reasoningLevels?: string[];
  planDepth?: string | null;
  setPlanDepth?: (v: string | null) => void;
  /** Currently-selected pipeline id, or null when not in pipeline mode. */
  selectedPipelineId: number | null;
  /** When streaming + queueable, show the queue split button beside Abort. */
  queueable?: boolean;
  onQueueSend?: (mode: QueueMode) => void;
}

export const ComposerToolbar = React.memo(function ComposerToolbar({
  hasInput,
  autoSuggestText,
  agent,
  setAgent,
  hideAgentPicker,
  onSend,
  onAbort,
  streaming,
  reasoningEffort,
  setReasoningEffort,
  reasoningLevels,
  planDepth,
  setPlanDepth,
  selectedPipelineId,
  queueable,
  onQueueSend,
}: ComposerToolbarProps) {
  const { t } = useTranslation(['chat', 'common']);

  return (
    <div className="flex items-center gap-2 px-2 pb-1.5 flex-wrap">
      {!hideAgentPicker && <AgentPicker value={agent} onChange={setAgent} autoSuggestFor={autoSuggestText} />}

      {/* Reasoning effort — only when the model exposes discrete effort levels. */}
      {setReasoningEffort && reasoningLevels && reasoningLevels.length > 0 && (
        <div
          className="flex items-center gap-1 text-muted-foreground"
          title={t('chat:toolbar.effortHint', { defaultValue: 'Reasoning effort (auto = model default)' })}
        >
          <Gauge className="h-3.5 w-3.5 shrink-0" />
          <select
            aria-label={t('chat:toolbar.effort', { defaultValue: 'Reasoning effort' })}
            className="h-7 rounded border bg-background px-1.5 text-xs"
            value={reasoningEffort ?? ''}
            onChange={(e) => setReasoningEffort(e.target.value === '' ? null : e.target.value)}
          >
            <option value="">{t('chat:toolbar.effortAuto', { defaultValue: 'auto' })}</option>
            {reasoningLevels.map((lv) => (
              <option key={lv} value={lv}>
                {lv}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Plan depth — only while the `plan` agent is active. */}
      {agent === 'plan' && setPlanDepth && (
        <div
          className="flex items-center gap-1 text-muted-foreground"
          title={t('chat:toolbar.planDepthHint', { defaultValue: 'Plan depth — how deep the planning agent goes' })}
        >
          <Layers className="h-3.5 w-3.5 shrink-0" />
          <select
            aria-label={t('chat:toolbar.planDepth', { defaultValue: 'Plan depth' })}
            className="h-7 rounded border bg-background px-1.5 text-xs"
            value={planDepth ?? 'normal'}
            onChange={(e) => setPlanDepth(e.target.value)}
          >
            <option value="simple">{t('chat:toolbar.planDepthSimple', { defaultValue: 'Simple' })}</option>
            <option value="normal">{t('chat:toolbar.planDepthNormal', { defaultValue: 'Normal' })}</option>
            <option value="complex">{t('chat:toolbar.planDepthComplex', { defaultValue: 'Complex' })}</option>
          </select>
        </div>
      )}

      <div className="ml-auto flex items-center gap-2">
        {streaming ? (
          <>
            {queueable && onQueueSend && (
              <QueueSplitButton hasInput={hasInput} onQueue={onQueueSend} />
            )}
            <Button onClick={onAbort} variant="destructive" size="sm">
              <Square className="h-3.5 w-3.5" /> {t('common:actions.stop')}
            </Button>
          </>
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
