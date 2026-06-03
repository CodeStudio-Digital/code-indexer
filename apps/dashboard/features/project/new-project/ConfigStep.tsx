/**
 * Step 2 — configure the chosen template: project name, optional
 * description, a repo URL (git-clone only), and a git-init toggle (empty
 * only). Shows a live preview of the on-disk folder slug.
 */
import { useTranslation } from 'react-i18next';
import { Input } from '../../../components/ui/input.js';
import { Textarea } from '../../../components/ui/textarea.js';
import { Switch } from '../../../components/ui/switch.js';
import { templateById, type TemplateId } from './templates.js';

export interface ConfigState {
  name: string;
  description: string;
  repoUrl: string;
  gitInit: boolean;
  /** Builder mode (react-vite only): Tailwind + shadcn + element selection. */
  builder: boolean;
}

interface ConfigStepProps {
  template: TemplateId;
  value: ConfigState;
  onChange: (patch: Partial<ConfigState>) => void;
}

/** Mirror of the backend slugify (preview only — server is authoritative). */
function previewSlug(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  return s || 'project';
}

export function ConfigStep({ template, value, onChange }: ConfigStepProps) {
  const { t } = useTranslation(['projects']);
  const meta = templateById(template);
  const slug = previewSlug(value.name);

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-sm font-medium">
          {t('wizard.nameLabel')} <span className="text-destructive">*</span>
        </label>
        <Input
          value={value.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder={t('wizard.namePlaceholder')}
          autoFocus
          required
        />
        <p className="text-xs text-muted-foreground">
          {t('wizard.locationHint')}{' '}
          <code className="font-mono">~/.mcp-code-indexer/projects/{slug}</code>
        </p>
      </div>

      {meta.requiresRepoUrl && (
        <div className="space-y-1.5">
          <label className="text-sm font-medium">
            {t('wizard.repoUrlLabel')} <span className="text-destructive">*</span>
          </label>
          <Input
            value={value.repoUrl}
            onChange={(e) => onChange({ repoUrl: e.target.value })}
            placeholder="https://github.com/user/repo.git"
            className="font-mono text-xs"
            required
          />
        </div>
      )}

      <div className="space-y-1.5">
        <label className="text-sm font-medium">{t('wizard.descLabel')}</label>
        <Textarea
          value={value.description}
          onChange={(e) => onChange({ description: e.target.value })}
          rows={2}
          placeholder={t('wizard.descPlaceholder')}
        />
      </div>

      {template === 'empty' && (
        <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
          <div>
            <div className="text-sm font-medium">{t('wizard.gitInitLabel')}</div>
            <p className="text-xs text-muted-foreground">{t('wizard.gitInitHint')}</p>
          </div>
          <Switch checked={value.gitInit} onCheckedChange={(v) => onChange({ gitInit: v })} />
        </label>
      )}

      {template === 'react-vite' && (
        <label className="flex items-center justify-between gap-3 rounded-md border border-indigo-300 dark:border-indigo-800 bg-indigo-50/50 dark:bg-indigo-950/30 px-3 py-2">
          <div>
            <div className="text-sm font-medium">
              {t('wizard.builderLabel', 'Builder mode (V0-style)')}
            </div>
            <p className="text-xs text-muted-foreground">
              {t(
                'wizard.builderHint',
                'Tailwind + shadcn/ui + click-to-edit element selection and a live preview beside the chat.',
              )}
            </p>
          </div>
          <Switch checked={value.builder} onCheckedChange={(v) => onChange({ builder: v })} />
        </label>
      )}
    </div>
  );
}
