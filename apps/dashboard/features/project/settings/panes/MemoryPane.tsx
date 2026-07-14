/** Agent-memory settings pane — single toggle (save-on-change). */

import { useTranslation } from 'react-i18next';
import type { Project } from '@mcp/shared/types.js';
import { Switch } from '../../../../components/ui/switch.js';
import type { PatchFn } from '../ProjectSettingsModal.js';

export function MemoryPane({ project, patch }: { project: Project; patch: PatchFn }) {
  const { t } = useTranslation(['projects']);
  return (
    <div className="w-full max-w-3xl space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <label className="text-sm font-medium">{t('edit.memoryLabel')}</label>
          <p className="text-xs text-muted-foreground">{t('edit.memoryHint')}</p>
        </div>
        <Switch
          checked={project.memory_enabled !== 0}
          onCheckedChange={(v) => void patch({ memory_enabled: v })}
        />
      </div>
    </div>
  );
}
