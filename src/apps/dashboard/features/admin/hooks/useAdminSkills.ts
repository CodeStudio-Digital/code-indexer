import { useEffect, useState } from 'react';
import { useConfirm, useNotify } from '../../../components/ui/dialog-provider.js';
import {
  fetchSkills,
  saveSkill,
  deleteSkill,
  duplicateSkill,
  exportSkill,
  importSkill,
  type AdminSkill,
} from '../skills-api.js';

export function useAdminSkills() {
  const confirm = useConfirm();
  const notify = useNotify();
  const [skills, setSkills] = useState<AdminSkill[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      setSkills(await fetchSkills());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async (s: Partial<AdminSkill>) => {
    const isExisting = !!skills.find((x) => x.id === s.id);
    try {
      await saveSkill(s, isExisting);
      await load();
    } catch (e) {
      await notify({
        title: 'Save failed',
        description: (e as Error).message,
        variant: 'destructive',
      });
    }
  };

  const remove = async (id: string) => {
    const ok = await confirm({
      title: `Delete skill "${id}"?`,
      description: 'This removes the skill. Active sessions will use the change on next run.',
      variant: 'destructive',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    await deleteSkill(id);
    await load();
  };

  const duplicate = async (id: string) => {
    try {
      await duplicateSkill(id);
      await load();
    } catch (e) {
      await notify({
        title: 'Duplicate failed',
        description: (e as Error).message,
        variant: 'destructive',
      });
    }
  };

  const doExport = async (id: string) => {
    try {
      const data = await exportSkill(id);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `skill-${id}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      await notify({
        title: 'Export failed',
        description: (e as Error).message,
        variant: 'destructive',
      });
    }
  };

  const doImport = async (json: string) => {
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      await importSkill(parsed, false);
      await load();
    } catch (e) {
      await notify({
        title: 'Import failed',
        description: (e as Error).message,
        variant: 'destructive',
      });
    }
  };

  return { skills, loading, load, save, remove, duplicate, doExport, doImport };
}
