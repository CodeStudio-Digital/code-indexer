/** Active project memory, with preserved legacy notes available on demand. */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MemoryOverview } from './parts/MemoryOverview.js';
import { AgentMemoryList } from './parts/AgentMemoryList.js';
import { LegacyMemoryNotes } from './parts/LegacyMemoryNotes.js';
import { MemorySemanticHealth } from './parts/MemorySemanticHealth.js';

export default function SnapshotEditor({ projectId }: { projectId: number }) {
  const { t } = useTranslation('projects');
  const [revision, setRevision] = useState(0);
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [scope, setScope] = useState<'project' | 'user'>('project');
  const changed = () => setRevision(value => value + 1);
  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto" data-testid="project-memory-surface">
      <div className="w-full max-w-6xl mx-auto p-4 md:p-6 space-y-5">
      <MemoryOverview key={projectId} projectId={projectId} revision={revision} onChanged={changed} />
      <MemorySemanticHealth key={`semantic-${projectId}`} projectId={projectId} revision={revision} />
      <section className="rounded-lg border bg-card/30 p-3 md:p-4">
        <div className="flex gap-1 border-b pb-3" role="group" aria-label={t('memory.overview.scope')}>
          {(['project', 'user'] as const).map(item => <button type="button" key={item} aria-pressed={scope === item}
            onClick={() => setScope(item)} className={`rounded-md px-3 py-1.5 text-xs font-medium ${scope === item ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-muted'}`}>{t(`memory.semantic.${item}`)}</button>)}
        </div>
        <AgentMemoryList key={`${projectId}:${scope}`} projectId={scope === 'user' ? 0 : projectId} revision={revision} onChanged={changed} />
      </section>
      <details className="rounded-lg border px-4 py-3" open={legacyOpen} onToggle={event => setLegacyOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer text-xs font-medium">{t('memory.legacy.title')}</summary>
        {legacyOpen && <LegacyMemoryNotes projectId={projectId} onImported={changed} />}
      </details>
      </div>
    </div>
  );
}
