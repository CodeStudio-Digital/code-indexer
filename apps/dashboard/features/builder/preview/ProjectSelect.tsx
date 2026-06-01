import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionProject } from './useSessionProjects.js';

interface Props {
  projects: SessionProject[];
  value: number | null;
  onChange: (projectId: number) => void;
}

/**
 * Compact dropdown used by every workspace tab (Files, Git) to pick
 * which linked project it operates on. Keeping this as a standalone
 * component avoids duplicating the styling + select logic in each tab.
 */
export function ProjectSelect({ projects, value, onChange }: Props) {
  const { t } = useTranslation('workspace');
  if (projects.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        {t('projectSelect.noLinked')}
      </span>
    );
  }
  return (
    <select
      className="text-xs bg-background border rounded px-1.5 py-1 max-w-[220px]"
      value={value ?? ''}
      onChange={(e) => onChange(Number(e.target.value))}
      title={t('projectSelect.activeTitle')}
    >
      {projects.map((p) => (
        <option key={p.project_id} value={p.project_id}>
          {p.label ? `${p.project_name} (${p.label})` : p.project_name}
        </option>
      ))}
    </select>
  );
}
