/**
 * New Project wizard — scaffolds a project on the host under
 * `~/.codestudio-local/projects/<slug>` from a stack template / git clone / empty, then
 * hands the registered project up via `onCreated` (ProjectList navigates
 * to it). Three steps: pick template → configure → live scaffold progress.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, ArrowLeft } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog.js';
import { TemplateGrid } from './TemplateGrid.js';
import { ConfigStep, type ConfigState } from './ConfigStep.js';
import { ScaffoldProgress } from './ScaffoldProgress.js';
import { useScaffoldStream, type CreatedProject } from './useScaffoldStream.js';
import { templateById, type TemplateId } from './templates.js';

interface NewProjectWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: CreatedProject) => void;
}

type Step = 'pick' | 'config' | 'progress';

const EMPTY_CONFIG: ConfigState = { name: '', description: '', repoUrl: '', gitInit: true, builder: false };

export default function NewProjectWizard({ open, onOpenChange, onCreated }: NewProjectWizardProps) {
  const { t } = useTranslation(['projects', 'common']);
  const [step, setStep] = useState<Step>('pick');
  const [template, setTemplate] = useState<TemplateId | null>(null);
  const [config, setConfig] = useState<ConfigState>(EMPTY_CONFIG);
  const scaffold = useScaffoldStream();

  // On success, surface the project and close once.
  useEffect(() => {
    if (scaffold.status === 'done' && scaffold.project) {
      onCreated(scaffold.project);
      close();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scaffold.status, scaffold.project]);

  function close() {
    scaffold.cancel();
    onOpenChange(false);
    // Defer reset so the closing animation doesn't flash step 1.
    setTimeout(() => {
      setStep('pick');
      setTemplate(null);
      setConfig(EMPTY_CONFIG);
      scaffold.reset();
    }, 150);
  }

  function handleOpenChange(next: boolean) {
    if (!next) close();
    else onOpenChange(true);
  }

  function pickTemplate(id: TemplateId) {
    setTemplate(id);
    setStep('config');
  }

  const meta = template ? templateById(template) : null;
  const nameValid = config.name.trim().length > 0;
  const repoValid = !meta?.requiresRepoUrl || config.repoUrl.trim().length > 0;
  const canCreate = !!template && nameValid && repoValid;

  function handleCreate() {
    if (!template || !canCreate) return;
    setStep('progress');
    void scaffold.start({
      template,
      name: config.name.trim(),
      description: config.description.trim() || undefined,
      repoUrl: meta?.requiresRepoUrl ? config.repoUrl.trim() : undefined,
      gitInit: template === 'empty' ? config.gitInit : undefined,
      builder: template === 'react-vite' ? config.builder : undefined,
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle>{t('wizard.title')}</DialogTitle>
              <DialogDescription>{t('wizard.description')}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {step === 'pick' && (
          <TemplateGrid selected={template} onSelect={pickTemplate} />
        )}
        {step === 'config' && template && (
          <ConfigStep template={template} value={config} onChange={(p) => setConfig((c) => ({ ...c, ...p }))} />
        )}
        {step === 'progress' && (
          <ScaffoldProgress status={scaffold.status} phase={scaffold.phase} log={scaffold.log} error={scaffold.error} />
        )}

        <DialogFooter>
          {step === 'config' && (
            <Button type="button" variant="outline" onClick={() => setStep('pick')}>
              <ArrowLeft className="h-4 w-4" /> {t('common:actions.back', { defaultValue: 'Back' })}
            </Button>
          )}
          {step === 'progress' && scaffold.status === 'error' && (
            <Button type="button" variant="outline" onClick={() => setStep('config')}>
              <ArrowLeft className="h-4 w-4" /> {t('common:actions.back', { defaultValue: 'Back' })}
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={close}>
            {scaffold.status === 'running' ? t('common:actions.cancel') : t('common:actions.close', { defaultValue: 'Close' })}
          </Button>
          {step === 'config' && (
            <Button type="button" onClick={handleCreate} disabled={!canCreate}>
              {t('wizard.create')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
