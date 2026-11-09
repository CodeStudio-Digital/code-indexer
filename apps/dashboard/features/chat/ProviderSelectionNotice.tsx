import { useTranslation } from 'react-i18next';
import type { ProviderSwitchState } from '../../hooks/agent-stream/provider-switch.js';

export function ProviderSelectionNotice({ state, onRetry }: { state: ProviderSwitchState | null; onRetry: () => void }) {
  const { t } = useTranslation('chat');
  if (!state?.pending && !state?.error) return null;
  return <div role={state.error ? 'alert' : 'status'} className="flex items-center gap-3 border-t border-border px-3 py-2 text-xs">
    <div className="min-w-0 flex-1">
      {state.error ? <>
        <p className="text-destructive">{t('providerSwitch.failed', { defaultValue: 'Não foi possível aplicar o provider selecionado. O envio está suspenso para evitar usar outro modelo.' })}</p>
        <p className="mt-1 break-words text-muted-foreground">{state.error}</p>
      </> : t('providerSwitch.saving', { defaultValue: 'Aplicando provider e modelo antes do próximo envio…' })}
    </div>
    {state.error && <button type="button" className="shrink-0 rounded border border-border px-2 py-1" onClick={onRetry}>
      {t('providerSwitch.retry', { defaultValue: 'Tentar novamente' })}
    </button>}
  </div>;
}
