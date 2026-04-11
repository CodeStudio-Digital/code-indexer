import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Combobox } from '../../components/ui/combobox.js';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { apiDelete, apiPatch } from '../../hooks/useApi.js';

interface Project {
  id: number;
  name: string;
  root_path: string;
  description?: string | null;
  group_name?: string | null;
}

interface ProjectEditDialogProps {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  onDeleted?: () => void;
  existingGroups?: string[];
}

export default function ProjectEditDialog({
  project,
  open,
  onOpenChange,
  onSaved,
  onDeleted,
  existingGroups = [],
}: ProjectEditDialogProps) {
  const [name, setName] = useState(project.name);
  const [rootPath, setRootPath] = useState(project.root_path);
  const [description, setDescription] = useState(project.description ?? '');
  const [groupName, setGroupName] = useState(project.group_name ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const groupOptions = existingGroups.map((g) => ({ value: g, label: g }));

  async function handleDelete() {
    setDeleting(true);
    try {
      await apiDelete(`/projects/${project.id}`);
      onOpenChange(false);
      onDeleted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const body: Record<string, string | null> = {};
      if (name !== project.name) body.name = name;
      if (rootPath !== project.root_path) body.root_path = rootPath;
      if (description !== (project.description ?? '')) body.description = description;
      const newGroup = groupName.trim() || null;
      if (newGroup !== (project.group_name ?? null)) body.group_name = newGroup;

      if (Object.keys(body).length === 0) {
        onOpenChange(false);
        return;
      }

      await apiPatch(`/projects/${project.id}`, body);
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit project</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Root path</label>
            <Input
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
              className="font-mono text-xs"
              required
            />
            <p className="text-xs text-muted-foreground">
              Caminho absoluto pra pasta do código. Atualize aqui se você moveu o projeto de lugar.
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Group</label>
            {groupOptions.length > 0 ? (
              <Combobox
                value={groupName}
                onChange={setGroupName}
                options={groupOptions}
                placeholder="Sem grupo"
                searchPlaceholder="Buscar ou criar grupo…"
                emptyLabel="Digite para criar um novo grupo"
                allowCustom
                size="md"
              />
            ) : (
              <Input
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="Ex: ZapCode, Personal…"
              />
            )}
            <p className="text-xs text-muted-foreground">
              Agrupa projetos relacionados na listagem. Deixe em branco para não agrupar.
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Description</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>
          {error && <div className="text-sm text-destructive">{error}</div>}

          {confirmDelete ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-3">
              <p className="text-sm text-destructive font-medium">
                Remover <strong>{project.name}</strong> do índice? Os arquivos não serão apagados.
              </p>
              <div className="flex gap-2 justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmDelete(false)}
                  disabled={deleting}
                >
                  Cancelar
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={handleDelete}
                  disabled={deleting}
                >
                  {deleting ? 'Removendo…' : 'Confirmar exclusão'}
                </Button>
              </div>
            </div>
          ) : (
            <DialogFooter className="gap-2 sm:justify-between">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={() => setConfirmDelete(true)}
                disabled={saving}
              >
                <Trash2 className="h-4 w-4 mr-1.5" />
                Deletar projeto
              </Button>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
                  Cancel
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </DialogFooter>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
