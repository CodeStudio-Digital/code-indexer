/** Active project memory, with preserved legacy notes available on demand. */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MemoryHealthCard } from './parts/MemoryHealthCard.js';
import { AgentMemoryHealthCard } from './parts/AgentMemoryHealthCard.js';
import { AgentMemoryList } from './parts/AgentMemoryList.js';
import { LegacyMemoryNotes } from './parts/LegacyMemoryNotes.js';
import { MemorySemanticHealth } from './parts/MemorySemanticHealth.js';

export default function SnapshotEditor({ projectId }: { projectId: number }) {
  const { t } = useTranslation('projects');
  const [revision, setRevision] = useState(0);
  const [legacyOpen, setLegacyOpen] = useState(false);
  const changed = () => setRevision(value => value + 1);
  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto" data-testid="project-memory-surface">
      <MemoryHealthCard key={`health-${projectId}-${revision}`} projectId={projectId} />
      <AgentMemoryHealthCard key={`usage-${projectId}-${revision}`} projectId={projectId} />
      <MemorySemanticHealth key={`semantic-${projectId}-${revision}`} projectId={projectId} />
      <AgentMemoryList projectId={projectId} revision={revision} onChanged={changed} />
      <details className="border-t px-3 py-2" open={legacyOpen} onToggle={event => setLegacyOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer text-xs font-medium">{t('memory.legacy.title')}</summary>
        {legacyOpen && <LegacyMemoryNotes projectId={projectId} onImported={changed} />}
      </details>
    </div>
  );
}
