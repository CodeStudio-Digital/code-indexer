/**
 * The "session-level" composer action icons: attach files, pipeline picker,
 * extended-thinking, describe-images (vision fallback), unrestricted tool
 * output (cap→full) and the tool-permission-mode shield.
 *
 * Extracted from Composer so the full chat composer AND the compact editor
 * Copilot rail (`RailComposerBar`) render the EXACT same controls from one
 * source of truth — anything wired here is available in both surfaces.
 */
import { memo, useEffect, useRef, useState } from 'react';
import { Brain, Eye, Paperclip, Shield, ShieldCheck, ShieldOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip.js';
import { PipelinePicker } from './PipelinePicker.js';
import { OutputCapPicker } from './OutputCapPicker.js';
import { MicButton } from './MicButton.js';
import { MicDevicePicker } from './MicDevicePicker.js';
import type { OutputCapLevel } from './output-cap-levels.js';
import { SessionFilesystemRootsControl } from './SessionFilesystemRootsControl.js';

interface ComposerActionIconsProps {
  streaming: boolean;
  handleFiles: (files: FileList | null) => Promise<void>;
  thinking?: boolean;
  setThinking?: (v: boolean) => void;
  /** Ultra owns the effective reasoning flag; preserve the stored Standard preference. */
  thinkingManaged?: boolean;
  describeImages?: boolean;
  setDescribeImages?: (v: boolean) => void;
  outputCapLevel?: OutputCapLevel;
  setOutputCapLevel?: (v: OutputCapLevel) => void;
  toolPermissionMode?: 'ask' | 'auto' | 'unrestricted';
  setToolPermissionMode?: (v: 'ask' | 'auto' | 'unrestricted') => void;
  sessionId?: number | null;
  selectedPipelineId?: number | null;
  setSelectedPipelineId?: (v: number | null) => void;
  /** Hide the thinking icon (the rail renders its own prominent Think pill). */
  showThink?: boolean;
  /** Append voice-transcribed text to the composer input. Hides the mic when unset. */
  onTranscript?: (text: string) => void;
  /** Render the mic + device picker here. The full chat composer sets this
   *  false and renders them after the model chip instead. Default true (rail). */
  showMic?: boolean;
}

export const ComposerActionIcons = memo(function ComposerActionIcons({
  streaming,
  handleFiles,
  thinking,
  setThinking,
  thinkingManaged = false,
  describeImages,
  setDescribeImages,
  outputCapLevel,
  setOutputCapLevel,
  toolPermissionMode,
  setToolPermissionMode,
  sessionId,
  selectedPipelineId,
  setSelectedPipelineId,
  showThink = true,
  onTranscript,
  showMic = true,
}: ComposerActionIconsProps) {
  const { t } = useTranslation('chat');
  // Transient "applied to the running session" pulse: the permission-mode
  // PATCH already pushes into the live runner mid-run, but that change is
  // invisible. Flash a ring on the shield when toggled while streaming so the
  // user sees it took effect on the active run. Pure visual.
  const [permissionPulse, setPermissionPulse] = useState(false);
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(pulseTimer.current), []);
  const cyclePermissionMode = () => {
    const mode = toolPermissionMode ?? 'auto';
    const next = mode === 'ask' ? 'auto' : mode === 'auto' ? 'unrestricted' : 'ask';
    setToolPermissionMode?.(next);
    if (streaming) {
      setPermissionPulse(true);
      clearTimeout(pulseTimer.current);
      pulseTimer.current = setTimeout(() => setPermissionPulse(false), 1200);
    }
  };
  return (
    <>
      <label className="cursor-pointer" title={t('composer.attach', { defaultValue: 'Anexar arquivos' })}>
        <input
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = '';
          }}
          disabled={streaming}
        />
        <span
          aria-label={t('composer.attach', { defaultValue: 'Anexar arquivos' })}
          className={`inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors ${
            streaming
              ? 'text-muted-foreground/40 cursor-not-allowed'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted'
          }`}
        >
          <Paperclip className="h-3.5 w-3.5" />
        </span>
      </label>

      {showMic && onTranscript && (
        <span className="inline-flex items-center">
          <MicButton onTranscript={onTranscript} disabled={streaming} />
          <MicDevicePicker disabled={streaming} />
        </span>
      )}

      {setSelectedPipelineId && (
        <PipelinePicker
          sessionId={sessionId ?? null}
          selectedPipelineId={selectedPipelineId ?? null}
          onChange={setSelectedPipelineId}
          compact
        />
      )}

      {showThink && setThinking && (
        <button
          type="button"
          onClick={() => setThinking?.(!thinking)}
          aria-pressed={thinkingManaged || (thinking ?? false)}
          aria-label={t('composer.thinkingToggle', { defaultValue: 'Extended thinking' })}
          title={thinkingManaged
            ? t('ultra.thinkingManaged', { defaultValue: 'Ultra controls reasoning for this model. Your Think preference is preserved for Standard mode.' })
            : t('composer.thinkingToggle', { defaultValue: 'Extended thinking' })}
          disabled={thinkingManaged}
          className={`relative inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            thinkingManaged || thinking
              ? 'bg-purple-500/15 text-purple-500 hover:bg-purple-500/25'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted'
          }`}
        >
          <Brain className="h-3.5 w-3.5" />
          {(thinkingManaged || thinking) && (
            <span aria-hidden className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-purple-500" />
          )}
        </button>
      )}

      {setDescribeImages && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setDescribeImages?.(!describeImages)}
              aria-pressed={describeImages ?? false}
              className={`relative inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors ${
                describeImages
                  ? 'bg-sky-500/15 text-sky-500 hover:bg-sky-500/25'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
            >
              <Eye className="h-3.5 w-3.5" />
              {describeImages && (
                <span aria-hidden className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-sky-500" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[260px]">
            {t('toolbar.describeImages', {
              defaultValue:
                'Descrever imagens: força um modelo de visão a traduzir imagens anexadas (e screenshots) para texto. Aplica-se automaticamente quando o modelo atual não enxerga imagens. Configure o modelo em Configurações → Pipelines (papel "vision").',
            })}
          </TooltipContent>
        </Tooltip>
      )}

      {setOutputCapLevel && (
        <OutputCapPicker value={outputCapLevel ?? 'economic'} onChange={setOutputCapLevel} />
      )}

      {sessionId != null && (
        <SessionFilesystemRootsControl sessionId={sessionId} streaming={streaming} />
      )}

      {setToolPermissionMode && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={cyclePermissionMode}
              aria-label={t(`toolbar.permissionMode.${toolPermissionMode ?? 'auto'}`)}
              className={`relative inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors ${
                permissionPulse ? 'ring-2 ring-offset-1 ring-offset-background ring-current animate-pulse ' : ''
              }${
                toolPermissionMode === 'ask'
                  ? 'bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25'
                  : toolPermissionMode === 'unrestricted'
                    ? 'bg-red-500/15 text-red-500 hover:bg-red-500/25'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
            >
              {toolPermissionMode === 'ask' ? (
                <ShieldCheck className="h-3.5 w-3.5" />
              ) : toolPermissionMode === 'unrestricted' ? (
                <ShieldOff className="h-3.5 w-3.5" />
              ) : (
                <Shield className="h-3.5 w-3.5" />
              )}
              {toolPermissionMode !== 'auto' && toolPermissionMode !== undefined && (
                <span
                  aria-hidden
                  className={`absolute top-1 right-1 h-1.5 w-1.5 rounded-full ${
                    toolPermissionMode === 'ask' ? 'bg-emerald-500' : 'bg-red-500'
                  }`}
                />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[280px]">
            <span className="font-medium">
              {t(`toolbar.permissionMode.${toolPermissionMode ?? 'auto'}`, {
                defaultValue:
                  toolPermissionMode === 'ask'
                    ? 'Solicitar Permissão'
                    : toolPermissionMode === 'unrestricted'
                      ? 'Sem Impedimento'
                      : 'Modo Auto',
              })}
            </span>
            {' — '}
            {t(`toolbar.permissionModeTip.${toolPermissionMode ?? 'auto'}`, {
              defaultValue:
                toolPermissionMode === 'ask'
                  ? 'toda ferramenta de escrita/execução/admin pausa e pede sua aprovação.'
                  : toolPermissionMode === 'unrestricted'
                    ? 'nunca pergunta — o agente executa tudo livremente.'
                    : 'edições de arquivos rodam livres; shell, git e ações administrativas pedem aprovação.',
            })}{' '}
            {t('toolbar.permissionModeCycle', { defaultValue: 'Clique para alternar.' })}
          </TooltipContent>
        </Tooltip>
      )}
    </>
  );
});
