import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiPost } from '../../../hooks/useApi.js';
import { toast } from '../../../components/ui/prompt-dialog.js';
import type { ProjectCardData as Project } from './project-card-types.js';
export function useProjectIndexAction(refetch: () => void) {
  const { t } = useTranslation(['projects', 'common']);
  const [indexingIds, setIndexingIds] = useState<Set<number>>(new Set());
  const indexingIdsRef = useRef<Set<number>>(new Set());
  const handleIndexProject = useCallback(
    async (p: Project) => {
      if (indexingIdsRef.current.has(p.id)) return;
      indexingIdsRef.current.add(p.id);
      setIndexingIds((current) => new Set(current).add(p.id));
      try {
        const result = await apiPost<{ ok: boolean }>(
          `/projects/${encodeURIComponent(p.id)}/index/structural/reconcile`,
          {},
        );
        refetch();
        if (result.ok) {
          toast.success(t('projects:indexAction.completed'), {
            description: p.name,
          });
        } else {
          toast.info(t('projects:indexAction.continuing'), {
            description: p.name,
          });
        }
      } catch (indexError) {
        toast.error(t('projects:indexAction.failed'), {
          description:
            indexError instanceof Error ? indexError.message : String(indexError),
        });
      } finally {
        indexingIdsRef.current.delete(p.id);
        setIndexingIds((current) => {
          const next = new Set(current);
          next.delete(p.id);
          return next;
        });
      }
    },
    [refetch, t],
  );


  return { indexingIds, handleIndexProject };
}
