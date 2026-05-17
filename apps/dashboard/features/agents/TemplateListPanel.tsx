import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Edit2, Plus, Trash2, Users, Crown } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
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

  async function handleDelete(e: React.MouseEvent, id: number) {
    e.stopPropagation();
    await apiDelete(`/company/templates/${id}`);
    refetch();
  }

  return (
    <>
      <div className="p-2">
        <Button variant="outline" size="sm" className="w-full text-xs" onClick={onNewTemplate}>
          <Plus className="h-3 w-3 mr-1" /> {t('template.newTemplate')}
        </Button>
      </div>

      {(!templates || templates.length === 0) && (
        <p className="px-3 py-4 text-xs text-muted-foreground text-center">
          {t('template.noTemplates')}
        </p>
      )}

      {templates?.map((t) => (
        <div
          key={t.id}
          className="px-3 py-2.5 border-b text-xs hover:bg-muted/50 transition-colors group"
        >
          <div className="flex items-center gap-2">
            <Users className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="font-medium truncate flex-1">{t.name}</span>
            <span
              role="button"
              tabIndex={0}
              onClick={() => setEditingTemplate(t)}
              onKeyDown={(e) => e.key === 'Enter' && setEditingTemplate(t)}
              className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground cursor-pointer"
            >
              <Edit2 className="h-3 w-3" />
            </span>
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => handleDelete(e, t.id)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleDelete(e as unknown as React.MouseEvent, t.id); }}
              className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive cursor-pointer"
            >
              <Trash2 className="h-3 w-3" />
            </span>
          </div>
          {t.description && (
            <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{t.description}</p>
          )}
          <div className="flex flex-wrap gap-1 mt-1.5">
            {t.roles.map((r) => (
              <Badge key={r.role} variant="outline" className="text-[9px] px-1 py-0 gap-0.5">
                {r.role === 'master' && <Crown className="h-2.5 w-2.5 text-yellow-400" />}
                {r.role}
              </Badge>
            ))}
          </div>
        </div>
      ))}

      {editingTemplate && (
        <TemplateBuilderModal
          existingTemplate={editingTemplate}
          onClose={() => setEditingTemplate(null)}
          onSaved={() => { refetch(); setEditingTemplate(null); }}
        />
      )}
    </>
  );
}
