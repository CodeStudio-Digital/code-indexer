import { useTranslation } from 'react-i18next';
import { ProjectCard } from './ProjectCard.js';
import { ProjectRow } from './ProjectRow.js';
import type { ProjectCardData } from './project-card-types.js';
interface Props {
  list: ProjectCardData[];
  layout: 'cards' | 'compact';
  searchQuery: string;
  handleSelectProject: (project: ProjectCardData) => void;
  handleEditProject: (project: ProjectCardData) => void;
  handleIndexProject: (project: ProjectCardData, action?: 'refresh' | 'reconcile') => Promise<void>;
  handleToggleSelected: (project: ProjectCardData) => void;
  indexingIds: Set<number>;
  selectionMode: boolean;
  selectedIds: Set<number>;
}
export function ProjectListItems({ list, layout, searchQuery, handleSelectProject, handleEditProject, handleIndexProject, handleToggleSelected, indexingIds, selectionMode, selectedIds }: Props) {
  const { t } = useTranslation(['projects', 'common']);
    if (list.length === 0) {
      return (
        <p className="col-span-full text-center py-8 text-sm text-muted-foreground">
          {searchQuery.trim()
            ? t('projects:noMatch', { query: searchQuery })
            : t('projects:noProjectsForFilter')}
        </p>
      );
    }
    if (layout === 'compact') {
      return (
        <div className="overflow-hidden rounded-lg border bg-card/40">
          {list.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              onSelect={handleSelectProject}
              onEdit={handleEditProject}
              onIndex={handleIndexProject}
              onToggleSelected={handleToggleSelected}
              indexing={indexingIds.has(p.id)}
              selecting={selectionMode}
              selected={selectedIds.has(p.id)}
            />
          ))}
        </div>
      );
    }
    return (
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {list.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            onSelect={() => handleSelectProject(p)}
            onEdit={() => handleEditProject(p)}
            onIndex={() => void handleIndexProject(p)}
            onRebuild={() => void handleIndexProject(p, 'reconcile')}
            onToggleSelected={() => handleToggleSelected(p)}
            indexing={indexingIds.has(p.id)}
            selecting={selectionMode}
            selected={selectedIds.has(p.id)}
          />
        ))}
      </div>
    );

}
