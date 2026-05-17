import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button.js';

interface NewFrontDialogProps {
  onClose: () => void;
  onCreate: (label: string) => Promise<void> | void;
}

/**
 * Thin modal that asks for a label and fires `onCreate`. The parent
 * (`CompanySessionView`) drives the actual API call via
 * `useCompanyStream.createFront` so this component stays presentational.
 */
export function NewFrontDialog({ onClose, onCreate }: NewFrontDialogProps) {
  const { t } = useTranslation('agents');
  const [label, setLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = label.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await onCreate(trimmed);
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background border rounded-lg p-6 w-full max-w-md shadow-xl">
        <h2 className="text-lg font-semibold mb-1">{t('fronts.new_dialog_title', 'New front')}</h2>
        <p className="text-sm text-muted-foreground mb-4">
          {t('fronts.new_dialog_description', 'Open a parallel work front in this session. The new front gets its own master and board, sharing the project and sandbox with the others.')}
        </p>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="text"
            autoFocus
            className="border rounded px-3 py-2 text-sm bg-transparent"
            placeholder={t('fronts.label_placeholder', 'e.g. Backend cleanup')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <div className="flex justify-end gap-2 mt-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!label.trim() || submitting}>
              {submitting
                ? t('fronts.creating', 'Creating…')
                : t('fronts.create', 'Create front')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
