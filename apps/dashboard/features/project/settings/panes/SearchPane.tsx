/** Search & indexing settings pane — embeddings toggle + search mode (save-on-change). */

import { useTranslation } from 'react-i18next';
import type { Project } from '@mcp/shared/types.js';
import { Switch } from '../../../../components/ui/switch.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../components/ui/select.js';
import type { PatchFn } from '../ProjectSettingsModal.js';

export function SearchPane({ project, patch }: { project: Project; patch: PatchFn }) {
  const { t } = useTranslation(['projects']);
  const embeddings = project.embeddings_enabled !== 0;
  const searchMode = project.search_mode ?? 'hybrid';

  return (
    <div className="space-y-5 max-w-xl">
      <h3 className="text-sm font-semibold">{t('settings.nav.search')}</h3>

      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <label className="text-sm font-medium">{t('edit.embeddingsLabel')}</label>
          <p className="text-xs text-muted-foreground">{t('edit.embeddingsHint')}</p>
        </div>
        <Switch checked={embeddings} onCheckedChange={(v) => void patch({ embeddings_enabled: v ? 1 : 0 })} />
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium">{t('edit.searchModeLabel')}</label>
        <Select value={searchMode} onValueChange={(v) => void patch({ search_mode: v })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="hybrid">{t('edit.searchModeHybrid')}</SelectItem>
            <SelectItem value="fts">{t('edit.searchModeFts')}</SelectItem>
            <SelectItem value="vector">{t('edit.searchModeVector')}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t('edit.searchModeHint')}</p>
      </div>
    </div>
  );
}
