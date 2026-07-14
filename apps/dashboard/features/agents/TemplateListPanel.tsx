import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Crown, LayoutTemplate, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { useApi, apiDelete } from '../../hooks/useApi.js';
import { TemplateBuilderModal } from './TemplateBuilderModal.js';

interface RoleConfig {
  role: string;
  provider: string;
  model: string;
  tier: string;
  skills?: string[];
}

interface Template {
  id: number;
  name: string;
  description: string;
  roles: RoleConfig[];
  created_at: string;
}

interface TemplateListPanelProps {
  onNewTemplate: () => void;
}

export function TemplateListPanel({ onNewTemplate }: TemplateListPanelProps) {
  const { t } = useTranslation('agents');
  const { data: templates, refetch } = useApi<Template[]>('/company/templates');
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Template | null>(null);
  const [query, setQuery] = useState('');

  const filtered = (templates ?? []).filter((template) => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return true;
    return `${template.name} ${template.description} ${template.roles.map((role) => role.role).join(' ')}`
      .toLocaleLowerCase()
      .includes(normalized);
  });

  async function handleDelete(id: number) {
    await apiDelete(`/company/templates/${id}`);
    setDeleteTarget(null);
    refetch();
  }

  return (
    <>
      <div className="border-b border-[var(--workbench-border)] p-1.5">
        <label className="flex h-7 items-center gap-1.5 rounded border border-[var(--workbench-border)] bg-[var(--workbench-canvas)] px-2 text-muted-foreground focus-within:border-[var(--workbench-focus)]">
          <Search className="h-3.5 w-3.5 shrink-0" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filtrar templates…"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>

      <div className="flex-1 space-y-1 overflow-y-auto p-1.5">
        {filtered.length === 0 && (
          <div className="px-3 py-8 text-center">
            <LayoutTemplate className="mx-auto mb-2 h-6 w-6 text-muted-foreground/50" />
            <p className="text-[11px] font-medium text-foreground">
              {query ? 'Nenhum template encontrado' : t('template.noTemplates')}
            </p>
            {!query && (
              <Button variant="outline" size="sm" className="mt-3 h-7 gap-1 text-[10px]" onClick={onNewTemplate}>
                <Plus className="h-3 w-3" /> {t('template.newTemplate')}
              </Button>
            )}
          </div>
        )}

        {filtered.map((template) => (
          <div
            key={template.id}
            role="button"
            tabIndex={0}
            onClick={() => setEditingTemplate(template)}
            onKeyDown={(event) => event.key === 'Enter' && setEditingTemplate(template)}
            className="group rounded-md border border-transparent px-2 py-2 text-xs transition-colors hover:border-[var(--workbench-border)] hover:bg-[var(--workbench-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--workbench-focus)]"
          >
            <div className="flex items-start gap-2">
              <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded bg-[var(--workbench-raised)] text-muted-foreground">
                <LayoutTemplate className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-medium text-foreground">{template.name}</span>
                <span className="mt-0.5 block line-clamp-2 text-[10px] leading-4 text-muted-foreground">
                  {template.description || 'Blueprint reutilizável de agentes'}
                </span>
              </span>
              <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setEditingTemplate(template);
                  }}
                  aria-label={`Editar ${template.name}`}
                  className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-[var(--workbench-active)] hover:text-foreground"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setDeleteTarget(template);
                  }}
                  aria-label={`Excluir ${template.name}`}
                  className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1 pl-8">
              {template.roles.slice(0, 4).map((role) => (
                <Badge key={role.role} variant="outline" className="h-4 gap-0.5 px-1 text-[8px] font-normal">
                  {role.role === 'master' && <Crown className="h-2 w-2 text-amber-400" />}
                  {role.role}
                </Badge>
              ))}
              {template.roles.length > 4 && (
                <Badge variant="outline" className="h-4 px-1 text-[8px] font-normal">+{template.roles.length - 4}</Badge>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="flex h-7 items-center border-t border-[var(--workbench-border)] px-2 text-[10px] text-muted-foreground">
        {filtered.length} de {templates?.length ?? 0} templates
      </div>

      {editingTemplate && (
        <TemplateBuilderModal
          existingTemplate={editingTemplate}
          onClose={() => setEditingTemplate(null)}
          onSaved={() => { refetch(); setEditingTemplate(null); }}
        />
      )}

      {deleteTarget && (
        <Dialog open onOpenChange={(open) => !open && setDeleteTarget(null)}>
          <DialogContent className="max-w-md border-[var(--workbench-border)] bg-[var(--workbench-surface)]">
            <DialogHeader>
              <DialogTitle>Excluir template</DialogTitle>
              <DialogDescription>
                O blueprint <strong className="text-foreground">{deleteTarget.name}</strong> deixará de aparecer na criação de empresas. As empresas existentes não serão alteradas.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)}>Cancelar</Button>
              <Button variant="destructive" size="sm" onClick={() => void handleDelete(deleteTarget.id)}>Excluir template</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
