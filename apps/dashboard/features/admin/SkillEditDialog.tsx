import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Switch } from '../../components/ui/switch.js';
import type { AdminSkill, SkillContextMode } from './skills-api.js';

interface SkillEditDialogProps {
  initial: Partial<AdminSkill>;
  isExisting: boolean;
  onClose: () => void;
  onSave: (s: Partial<AdminSkill>) => void;
}

const CONTEXT_MODE_VALUES: SkillContextMode[] = ['auto', 'tool', 'both'];
const CONTEXT_MODE_LABEL_KEYS: Record<SkillContextMode, string> = {
  auto: 'skillEdit.contextAuto',
  tool: 'skillEdit.contextTool',
  both: 'skillEdit.contextBoth',
};
const CONTEXT_MODE_DESC_KEYS: Record<SkillContextMode, string> = {
  auto: 'skillEdit.contextAutoDesc',
  tool: 'skillEdit.contextToolDesc',
  both: 'skillEdit.contextBothDesc',
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

export function SkillEditDialog({ initial, isExisting, onClose, onSave }: SkillEditDialogProps) {
  const { t } = useTranslation(['admin', 'common']);
  const isNew = !isExisting;
  const [form, setForm] = useState<Partial<AdminSkill>>({
    context_mode: 'auto',
    scope: 'global',
    enabled: true,
    sort_order: 0,
    tags: [],
    variables: [],
    version: '1.0.0',
    source: 'user',
    ...initial,
  });
  const [autoId, setAutoId] = useState(isNew);

  function update<K extends keyof AdminSkill>(k: K, v: AdminSkill[K] | null) {
    setForm((f) => {
      const next = { ...f, [k]: v };
      // Auto-generate ID from name for new skills
      if (k === 'name' && autoId) {
        next.id = slugify(v as string);
      }
      return next;
    });
  }

  function submit() {
    onSave({
      id: form.id,
      name: form.name,
      description: form.description || '',
      slash_command: form.slash_command || null,
      prompt_body: form.prompt_body,
      scope: form.scope || 'global',
      enabled: form.enabled ?? true,
      allowed_tools: form.allowed_tools,
      model_override: form.model_override || null,
      provider_override: form.provider_override || null,
      context_mode: form.context_mode || 'auto',
      sort_order: form.sort_order ?? 0,
      tags: form.tags ?? [],
      path_patterns: form.path_patterns,
      author: form.author || null,
      version: form.version || '1.0.0',
      source: form.source || 'user',
    });
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isNew ? t('admin:skillEdit.createTitle') : t('admin:skillEdit.editTitle', { name: form.name })}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Name */}
          <div>
            <label className="text-sm font-medium">{t('admin:skillEdit.name')}</label>
            <Input
              value={form.name ?? ''}
              onChange={(e) => update('name', e.target.value)}
              placeholder={t('admin:skillEdit.namePlaceholder')}
            />
          </div>

          {/* ID */}
          <div>
            <label className="text-sm font-medium">{t('admin:skillEdit.id')}</label>
            <div className="flex items-center gap-2">
              <Input
                value={form.id ?? ''}
                onChange={(e) => { setAutoId(false); setForm((f) => ({ ...f, id: e.target.value })); }}
                placeholder={t('admin:skillEdit.idPlaceholder')}
                disabled={isExisting}
                className="font-mono text-sm"
              />
              {isNew && (
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {autoId ? t('admin:skillEdit.idAuto') : t('admin:skillEdit.idManual')}
                </span>
              )}
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="text-sm font-medium">{t('admin:skillEdit.description')}</label>
            <Input
              value={form.description ?? ''}
              onChange={(e) => update('description', e.target.value)}
              placeholder={t('admin:skillEdit.descriptionPlaceholder')}
            />
          </div>

          {/* Slash command */}
          <div>
            <label className="text-sm font-medium">{t('admin:skillEdit.slashCommand')}</label>
            <div className="flex items-center gap-1">
              <span className="text-sm text-muted-foreground">/</span>
              <Input
                value={form.slash_command ?? ''}
                onChange={(e) => update('slash_command', e.target.value || null)}
                placeholder={t('admin:skillEdit.slashPlaceholder')}
                className="font-mono text-sm"
              />
            </div>
          </div>

          {/* Prompt body */}
          <div>
            <label className="text-sm font-medium">{t('admin:skillEdit.promptBody')}</label>
            <p className="text-xs text-muted-foreground mb-1">
              {t('admin:skillEdit.promptHint')}
            </p>
            <Textarea
              value={form.prompt_body ?? ''}
              onChange={(e) => update('prompt_body', e.target.value)}
              placeholder={t('admin:skillEdit.promptPlaceholder')}
              rows={10}
              className="font-mono text-sm"
            />
          </div>

          {/* Context mode */}
          <div>
            <label className="text-sm font-medium">{t('admin:skillEdit.contextMode')}</label>
            <Select
              value={form.context_mode ?? 'inline'}
              onValueChange={(v) => update('context_mode', v as SkillContextMode)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTEXT_MODE_VALUES.map((mv) => (
                  <SelectItem key={mv} value={mv}>
                    {t(`admin:${CONTEXT_MODE_LABEL_KEYS[mv]}`)} — {t(`admin:${CONTEXT_MODE_DESC_KEYS[mv]}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Scope */}
          <div>
            <label className="text-sm font-medium">{t('admin:skillEdit.scope')}</label>
            <Input
              value={form.scope ?? 'global'}
              onChange={(e) => update('scope', e.target.value)}
              placeholder={t('admin:skillEdit.scopePlaceholder')}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground mt-1">
              {t('admin:skillEdit.scopeHint')}
            </p>
          </div>

          {/* Tags */}
          <div>
            <label className="text-sm font-medium">{t('admin:skillEdit.tags')}</label>
            <Input
              value={(form.tags ?? []).join(', ')}
              onChange={(e) => update('tags', e.target.value.split(',').map((tg) => tg.trim()).filter(Boolean))}
              placeholder={t('admin:skillEdit.tagsPlaceholder')}
            />
          </div>

          {/* Sort order */}
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label className="text-sm font-medium">{t('admin:skillEdit.sortOrder')}</label>
              <Input
                type="number"
                value={form.sort_order ?? 0}
                onChange={(e) => update('sort_order', parseInt(e.target.value, 10) || 0)}
              />
            </div>
            <div className="flex items-center gap-2 pt-5">
              <Switch
                checked={form.enabled ?? true}
                onCheckedChange={(v) => update('enabled', v)}
              />
              <label className="text-sm">{t('admin:skillEdit.enabled')}</label>
            </div>
          </div>

          {/* Model override */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium">{t('admin:skillEdit.providerOverride')}</label>
              <Input
                value={form.provider_override ?? ''}
                onChange={(e) => update('provider_override', e.target.value || null)}
                placeholder={t('admin:skillEdit.sessionDefault')}
              />
            </div>
            <div>
              <label className="text-sm font-medium">{t('admin:skillEdit.modelOverride')}</label>
              <Input
                value={form.model_override ?? ''}
                onChange={(e) => update('model_override', e.target.value || null)}
                placeholder={t('admin:skillEdit.sessionDefault')}
              />
            </div>
          </div>

          {/* Allowed tools */}
          <div>
            <label className="text-sm font-medium">{t('admin:skillEdit.allowedTools')}</label>
            <Input
              value={(form.allowed_tools ?? []).join(', ')}
              onChange={(e) => {
                const val = e.target.value;
                update('allowed_tools', val ? val.split(',').map((tl) => tl.trim()).filter(Boolean) : null);
              }}
              placeholder={t('admin:skillEdit.allowedToolsPlaceholder')}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground mt-1">
              {t('admin:skillEdit.allowedToolsHint')}
            </p>
          </div>

          {/* Author + Version */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium">{t('admin:skillEdit.author')}</label>
              <Input
                value={form.author ?? ''}
                onChange={(e) => update('author', e.target.value || null)}
                placeholder={t('admin:skillEdit.authorPlaceholder')}
              />
            </div>
            <div>
              <label className="text-sm font-medium">{t('admin:skillEdit.version')}</label>
              <Input
                value={form.version ?? '1.0.0'}
                onChange={(e) => update('version', e.target.value)}
                placeholder={t('admin:skillEdit.versionPlaceholder')}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('common:actions.cancel')}</Button>
          <Button
            onClick={submit}
            disabled={!form.id || !form.name || !form.prompt_body}
          >
            {isNew ? t('common:actions.create') : t('common:actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
