import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Keep a failed or unacknowledged response visible and retryable. */
export function usePromptSubmission() {
  const { t } = useTranslation('chat');
  const pending = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (action: () => Promise<void>): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setSubmitting(true);
    setError(undefined);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('interaction.responseFailed')); }
    finally { pending.current = false; setSubmitting(false); }
  };
  return { submitting, error, submit };
}
