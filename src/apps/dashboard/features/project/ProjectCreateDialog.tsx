import { useState } from 'react';
import { FolderGit2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { apiPost } from '../../hooks/useApi.js';

interface CreatedProject {
  id: number;
  name: string;
  root_path: string;
}

interface ProjectCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: CreatedProject) => void;
}

/**
 * Create a project by picking/typing a folder path. The backend validates
 * that the path exists + is a directory and that neither the name nor the
 * root_path clash with an existing project.
 *
 * We keep it simple: no file browser (the HTTP API runs on the host and
 * the dashboard is a static bundle), just a raw text field for the path —
 * this matches what users already type in the CLI.
 */
export default function ProjectCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: ProjectCreateDialogProps) {
  const [rootPath, setRootPath] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function reset() {
    setRootPath('');
    setName('');
    setDescription('');
    setError(null);
    setSaving(false);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmedPath = rootPath.trim();
    if (!trimmedPath) {
      setError('Informe a pasta do projeto.');
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, string> = { root_path: trimmedPath };
      if (name.trim()) body.name = name.trim();
      if (description.trim()) body.description = description.trim();
      const created = await apiPost<CreatedProject>('/projects', body);
      onCreated(created);
      reset();
      onOpenChange(false);
    } catch (err) {
      // apiPost throws a generic `HTTP 4xx` — try to surface the server's
      // JSON error if the response is still readable. For now we keep it
      // simple and show the raw message.
      const raw = err instanceof Error ? err.message : String(err);
      if (raw.includes('409')) {
        setError('Já existe um projeto com esse nome ou pasta.');
      } else if (raw.includes('400')) {
        setError('Pasta inválida — confira se o caminho existe.');
      } else {
        setError(raw);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
              <FolderGit2 className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle>Novo projeto</DialogTitle>
              <DialogDescription>
                Registre uma pasta local no índice. Depois use o botão
                {' '}<strong>Run Index</strong> na aba Runs para analisar.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              Pasta do projeto <span className="text-destructive">*</span>
            </label>
            <Input
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
              placeholder="D:\\projetos\\meu-app"
              className="font-mono text-xs"
              autoFocus
              required
            />
            <p className="text-xs text-muted-foreground">
              Caminho absoluto. O servidor valida se a pasta existe antes de
              salvar.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Nome</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Owner/Repo (auto se vazio)"
            />
            <p className="text-xs text-muted-foreground">
              Deixe em branco para usar os dois últimos segmentos do caminho.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Descrição</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Opcional"
            />
          </div>

          {error && (
            <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
              {error}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={saving}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={saving || !rootPath.trim()}>
              {saving ? 'Criando…' : 'Criar projeto'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
