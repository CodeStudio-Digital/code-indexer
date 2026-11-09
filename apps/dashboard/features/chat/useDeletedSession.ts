import { useEffect } from 'react';

export function useDeletedSession(selectedId: string | null, setSelectedId: (id: string | null) => void): void {
  useEffect(() => {
    const onDeleted = (event: Event) => {
      const ids = (event as CustomEvent<{ ids: string[] }>).detail?.ids;
      if (selectedId && ids?.includes(selectedId)) setSelectedId(null);
    };
    window.addEventListener('coder:sessions-deleted', onDeleted);
    return () => window.removeEventListener('coder:sessions-deleted', onDeleted);
  }, [selectedId, setSelectedId]);
}
