/**
 * MicButton — composer microphone for voice-dictated prompts. Records audio,
 * transcribes it (Settings → Pipelines · role "transcription"), and appends the
 * transcript to the message input via `onTranscript`.
 *
 * Rendered in `ComposerActionIcons` (covers chat / global / editor rail) and
 * inline in `MasterComposer` (company). Visual states mirror the Brain toggle.
 */
import { useEffect, useRef } from 'react';
import { Loader2, Mic, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip.js';
import { toast } from '../../../components/ui/prompt-dialog.js';
import { useAudioRecorder, type RecorderErrorCode } from './useAudioRecorder.js';

interface MicButtonProps {
  onTranscript: (text: string) => void;
  disabled?: boolean;
  /** Optional ISO-639-1 hint (e.g. `pt`). Omit for auto-detect. */
  language?: string;
  /** Extra classes merged onto the button (e.g. spacing for an inline toolbar). */
  className?: string;
}

export function MicButton({ onTranscript, disabled, language, className }: MicButtonProps) {
  const { t } = useTranslation('chat');
  const { status, errorCode, start, stop } = useAudioRecorder({ onResult: onTranscript, language });
  const lastErrorRef = useRef<RecorderErrorCode | null>(null);

  // Surface recorder/transcription failures as a toast once per transition.
  useEffect(() => {
    if (status !== 'error' || !errorCode || lastErrorRef.current === errorCode) return;
    lastErrorRef.current = errorCode;
    const map: Record<RecorderErrorCode, { key: string; def: string }> = {
      denied: { key: 'composer.mic.errorDenied', def: 'Permissão de microfone negada. Habilite o acesso ao microfone.' },
      'no-device': { key: 'composer.mic.errorNoDevice', def: 'Nenhum microfone encontrado.' },
      busy: { key: 'composer.mic.errorBusy', def: 'Microfone em uso ou indisponível. Verifique se outro aplicativo está usando o microfone.' },
      unsupported: { key: 'composer.mic.errorUnsupported', def: 'Gravação de áudio não suportada neste ambiente.' },
      'no-model': { key: 'composer.mic.errorNoModel', def: 'Nenhum modelo de transcrição configurado.' },
      http: { key: 'composer.mic.errorHttp', def: 'Falha ao transcrever o áudio. Tente novamente.' },
      empty: { key: 'composer.mic.errorEmpty', def: 'Nenhuma fala detectada.' },
    };
    const m = map[errorCode];
    toast.error(t(m.key, { defaultValue: m.def }), {
      description:
        errorCode === 'no-model'
          ? t('composer.mic.errorNoModelHint', {
              defaultValue: 'Configure o papel "transcription" em Configurações → Pipelines.',
            })
          : undefined,
    });
  }, [status, errorCode, t]);

  useEffect(() => {
    if (status !== 'error') lastErrorRef.current = null;
  }, [status]);

  const recording = status === 'recording';
  const transcribing = status === 'transcribing';
  const busy = transcribing || status === 'requesting';
  const hardDisabled = disabled || busy;

  const onClick = () => {
    if (hardDisabled) return;
    if (recording) stop();
    else void start();
  };

  const label = recording
    ? t('composer.mic.stop', { defaultValue: 'Parar gravação' })
    : transcribing
      ? t('composer.mic.transcribing', { defaultValue: 'Transcrevendo…' })
      : t('composer.mic.start', { defaultValue: 'Gravar voz' });

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={hardDisabled}
          aria-pressed={recording}
          aria-label={label}
          className={`relative inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            recording
              ? 'bg-rose-500/15 text-rose-500 hover:bg-rose-500/25 animate-pulse'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted'
          }${className ? ` ${className}` : ''}`}
        >
          {transcribing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : recording ? (
            <Square className="h-3.5 w-3.5" />
          ) : (
            <Mic className="h-3.5 w-3.5" />
          )}
          {recording && (
            <span aria-hidden className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-rose-500" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}
