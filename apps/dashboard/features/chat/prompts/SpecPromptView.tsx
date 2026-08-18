import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, FileText, ScrollText, X } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Textarea } from '../../../components/ui/textarea.js';
import { cn } from '../../../lib/utils.js';
import { Markdown } from '../messages/Markdown.js';
import type { SpecPrompt } from '../../../hooks/agent-stream/types.js';
import {
  getPromptDraft,
  markPromptResolved,
  setPromptDraft,
} from '../../../hooks/agent-stream/prompt-resolution-store.js';
import { usePromptResolution } from '../../../hooks/agent-stream/usePromptResolution.js';

interface SpecPromptViewProps {
  spec: SpecPrompt;
  onResponse: (approved: boolean, spec_path: string, requested_changes?: string) => Promise<void>;
  /** Bridges this card to its persisted twin, which carries a different id. */
  signature?: string;
  sessionId?: string;
}

/**
 * SDD mode approval card — renders the spec body, file path, and three
 * verdict buttons (approve / request changes / abort). Mirrors PlanPromptView
 * in layout; tinted amber to match the spec agent's MODE_TINT.
 */
export function SpecPromptView({ spec, onResponse, signature, sessionId }: SpecPromptViewProps) {
  const { t } = useTranslation(['chat', 'common']);
  const [requested, setRequested] = useState(() => getPromptDraft<string>(spec.id) ?? '');
  const storedResolution = usePromptResolution<string>(spec.id, signature, sessionId);
  const resolved = spec.resolved ?? storedResolution;

  useEffect(() => {
    setPromptDraft(spec.id, requested);
  }, [requested, spec.id]);

  return (
    <div className="my-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="h-7 w-7 rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-400 flex items-center justify-center">
          <ScrollText className="h-4 w-4" />
        </div>
        <div className="text-xs font-semibold text-amber-700 dark:text-amber-300 uppercase tracking-wider flex-1 flex items-center gap-2">
          <span>{t('chat:spec.awaitingApproval', { defaultValue: 'Spec awaiting approval' })}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-muted-foreground">
            {spec.name}
          </span>
        </div>
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground font-mono">
          <FileText className="h-3 w-3" />
          <span>{spec.spec_path}</span>
        </div>
      </div>

      <div className="text-sm text-foreground mb-3 px-1 max-h-[60vh] overflow-y-auto">
        <Markdown text={spec.body} />
      </div>

      {!resolved ? (
        <>
          <Textarea
            value={requested}
            onChange={(e) => setRequested(e.target.value)}
            placeholder={t('chat:spec.requestedChangesPlaceholder', {
              defaultValue: 'What needs to change? (optional when approving)',
            })}
            rows={2}
            className="mb-2 text-xs"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="success"
              onClick={async () => {
                await onResponse(true, spec.spec_path, requested || undefined);
                markPromptResolved({ id: spec.id, signature, sessionId, resolution: 'approved' });
              }}
            >
              <Check className="h-3.5 w-3.5" /> {t('common:actions.approve')}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={async () => {
                await onResponse(false, spec.spec_path, requested || undefined);
                markPromptResolved({ id: spec.id, signature, sessionId, resolution: 'rejected' });
              }}
            >
              <X className="h-3.5 w-3.5" />{' '}
              {t('chat:spec.requestChanges', { defaultValue: 'Request changes' })}
            </Button>
          </div>
        </>
      ) : (
        <div
          className={cn(
            'text-xs flex items-center gap-1.5',
            resolved === 'approved' ? 'text-success' : 'text-destructive',
          )}
        >
          {resolved === 'approved' ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
          {resolved === 'approved'
            ? t('chat:spec.approved', { defaultValue: 'Spec approved' })
            : t('chat:spec.rejected', { defaultValue: 'Changes requested' })}
        </div>
      )}
    </div>
  );
}
