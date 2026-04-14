import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Copy,
  Download,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Switch } from '../../components/ui/switch.js';
import { SkillEditDialog } from './SkillEditDialog.js';
import { useAdminSkills } from './hooks/useAdminSkills.js';
import type { AdminSkill } from './skills-api.js';

const MODE_LABEL: Record<string, string> = {
  inline: 'Inline',
  tool: 'Tool',
  both: 'Both',
};

const MODE_COLOR: Record<string, string> = {
  inline: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  tool: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  both: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200',
};

export function SkillsPanel() {
  const { t } = useTranslation(['admin', 'common']);
  const { skills, loading, save, remove, duplicate, doExport, doImport } = useAdminSkills();
  const [editing, setEditing] = useState<Partial<AdminSkill> | null>(null);
  const [filter, setFilter] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const filtered = filter
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(filter.toLowerCase()) ||
          s.id.includes(filter.toLowerCase()) ||
          (s.tags ?? []).some((t) => t.toLowerCase().includes(filter.toLowerCase())),
      )
    : skills;

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    await doImport(text);
    // Reset input so same file can be imported again
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('admin:skills.filterPlaceholder')}
          className="flex h-9 w-full max-w-xs rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleImportFile}
            className="hidden"
          />
          <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
            <Upload className="h-4 w-4 mr-2" /> {t('common:actions.import')}
          </Button>
          <Button
            onClick={() =>
              setEditing({
                context_mode: 'inline',
                scope: 'global',
                enabled: true,
                sort_order: 0,
                tags: [],
                version: '1.0.0',
                source: 'user',
              })
            }
          >
            <Plus className="h-4 w-4 mr-2" /> {t('admin:skills.addSkill')}
          </Button>
        </div>
      </div>

      {loading && <div className="text-sm text-muted-foreground">{t('common:actions.loading')}</div>}

      <div className="grid gap-3">
        {filtered.map((s) => (
          <Card key={s.id} className="overflow-hidden">
            <CardHeader className="py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <Sparkles className="h-4 w-4 text-muted-foreground shrink-0" />
                  <CardTitle className="text-base truncate">{s.name}</CardTitle>
                  <Badge className={MODE_COLOR[s.context_mode] ?? ''}>
                    {MODE_LABEL[s.context_mode] ?? s.context_mode}
                  </Badge>
                  {s.slash_command && (
                    <Badge variant="outline" className="font-mono">
                      /{s.slash_command}
                    </Badge>
                  )}
                  {s.scope !== 'global' && (
                    <Badge variant="secondary">{t('admin:skills.project')}{s.scope}</Badge>
                  )}
                  {s.source === 'builtin' && (
                    <Badge variant="secondary">{t('admin:skills.builtin')}</Badge>
                  )}
                  {s.source === 'imported' && (
                    <Badge variant="secondary">{t('admin:skills.imported')}</Badge>
                  )}
                  {(s.tags ?? []).map((tag) => (
                    <Badge key={tag} variant="outline" className="text-xs">
                      {tag}
                    </Badge>
                  ))}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Switch
                    checked={s.enabled}
                    onCheckedChange={(v) => save({ ...s, enabled: v })}
                  />
                  <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => duplicate(s.id)}>
                    <Copy className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => doExport(s.id)}>
                    <Download className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => remove(s.id)}>
                    <Trash2 className="h-4 w-4 text-red-600" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            {s.description && (
              <CardContent className="py-2 text-xs text-muted-foreground">
                {s.description}
              </CardContent>
            )}
          </Card>
        ))}
        {!loading && filtered.length === 0 && (
          <div className="text-sm text-muted-foreground border rounded-lg p-6 text-center">
            {filter
              ? t('admin:skills.noMatch')
              : t('admin:skills.noSkills')}
          </div>
        )}
      </div>

      {editing && (
        <SkillEditDialog
          initial={editing}
          isExisting={!!skills.find((x) => x.id === editing.id)}
          onClose={() => setEditing(null)}
          onSave={async (s) => {
            await save(s);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
