/**
 * Session-level operational-rules editor.
 *
 * The rules are injected VERBATIM into the master AND every subordinate
 * system prompt (server-side, at start/spawn/resume) — so this is the single
 * place an operator sets cross-cutting policy (contract validation, no local
 * enum mapping, QA-vs-dev separation, self_review). Saving PATCHes the
 * session's `config_json`; new spawns pick it up immediately, the running
 * master on its next reestablish.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../components/ui/button.js';
import { Textarea } from '../../../components/ui/textarea.js';
import { apiPatch } from '../../../hooks/useApi.js';

interface OperationalRulesEditorProps {
  sessionId: number;
  /** Current value parsed from the session's config_json (operational_rules). */
  value: string;
  /** Re-fetch the session so the saved value round-trips back into `value`. */
  refetch: () => void;
}

export function OperationalRulesEditor({ sessionId, value, refetch }: OperationalRulesEditorProps) {
  const { t } = useTranslation('agents');
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // Tracks the last externally-synced value so we adopt server changes
  // (initial async load, post-save refetch) WITHOUT clobbering unsaved edits.
  const syncedRef = useRef(value);

  useEffect(() => {
    if (draft === syncedRef.current) setDraft(value);
    syncedRef.current = value;
  }, [value, draft]);

  const dirty = draft !== value;

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      await apiPatch(`/company/sessions/${sessionId}/config`, { operational_rules: draft });
      setSaved(true);
      refetch();
    } catch (e) {
      console.error('Failed to save operational rules:', e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-[10px] leading-snug text-muted-foreground">
        {t('company.operationalRules.sidebarHint')}
      </p>
      <Textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setSaved(false);
        }}
        placeholder={t('company.operationalRules.placeholder')}
        rows={10}
        className="text-[11px] font-mono resize-y min-h-[160px]"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={saving || !dirty}>
          {saving ? t('company.operationalRules.saving') : t('company.operationalRules.save')}
        </Button>
        {dirty ? (
          <span className="text-[10px] text-amber-500">
            {t('company.operationalRules.unsaved')}
          </span>
        ) : (
          saved && (
            <span className="text-[10px] text-muted-foreground">
              {t('company.operationalRules.saved')}
            </span>
          )
        )}
      </div>
    </div>
  );
}
