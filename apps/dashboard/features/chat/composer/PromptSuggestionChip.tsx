import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiPost, useApi } from '../../../hooks/useApi.js';
import type { PromptSuggestion } from '@mcp/api-bus';

/** Mounted only for an idle, empty composer. Late fetches are discarded by
 * useApi on unmount; a suggestion can only fill input after a human click. */
export function PromptSuggestionChip({ sessionId, onSelect }: { sessionId: string; onSelect(text: string): void }) {
  const { t } = useTranslation('chat');
  const { data } = useApi<{ suggestion: (PromptSuggestion & { title: string }) | null }>(`/coder/sessions/${sessionId}/collaboration/prompt-suggestion`);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const suggestion = data?.suggestion;
  if (!suggestion || suggestion.id === dismissed || suggestion.expiresAt <= Date.now()) return null;
  return <div className="flex items-center gap-2 px-2 py-1 text-xs">
    <button type="button" className="truncate text-muted-foreground hover:text-foreground" onClick={() => onSelect(suggestion.text)}>{suggestion.title}</button>
    <button type="button" aria-label={t('ultra.dismiss')} className="text-muted-foreground" onClick={() => {
      setDismissed(suggestion.id);
      void apiPost(`/coder/sessions/${sessionId}/collaboration/prompt-suggestion/${suggestion.id}/dismiss`, {}).catch(() => setDismissed(null));
    }}>×</button>
  </div>;
}
