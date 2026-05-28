/**
 * Tile-style card for the ProjectList grid layout — one project per
 * card with hover-lift, status badge, file/symbol counts and last-
 * indexed timestamp. Roughly 150px tall, used in the "cards" view of
 * `ProjectList`. The compact list view uses `ProjectRow` instead.
 */
import { useTranslation } from 'react-i18next';
import { Boxes, Clock, FileCode2, FolderGit2, Pencil } from 'lucide-react';
import { Badge } from '../../../components/ui/badge.js';
import { Button } from '../../../components/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../components/ui/card.js';
import { useContextMenu } from '../../../components/ui/context-menu.js';
import { formatRelativeTime } from '../../../lib/utils.js';
import { buildProjectContextMenuItems } from './projectContextMenu.js';

export interface ProjectCardData {
  id: number;
  name: string;
  root_path: string;
  description?: string | null;
  group_name?: string | null;
  file_count: number;
  symbol_count: number;
  last_indexed: string | null;
}

export interface ProjectCardProps {
  project: ProjectCardData;
  onSelect: () => void;
  onEdit: () => void;
}

export function ProjectCard({ project: p, onSelect, onEdit }: ProjectCardProps) {
  const { t } = useTranslation(['projects', 'common']);
  const { triggerProps, Menu } = useContextMenu(
    buildProjectContextMenuItems({
      project: p,
      onSelect,
      onEdit,
      labels: {
        open: t('projects:contextMenu.open', 'Open'),
        openInNewWindow: t('projects:contextMenu.openInNewWindow', 'Open in new window'),
        copyPath: t('projects:contextMenu.copyPath', 'Copy path'),
        edit: t('projects:contextMenu.edit', 'Edit'),
        copied: t('projects:contextMenu.copied', 'Copied'),
      },
    }),
  );
  return (
    <Card
      onClick={onSelect}
      {...triggerProps}
      className="cursor-pointer transition-all hover:shadow-md hover:border-primary/40 hover:-translate-y-0.5 group"
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center group-hover:bg-primary group-hover:text-primary-foreground transition-colors">
            <FolderGit2 className="h-5 w-5" />
          </div>
          <div className="flex items-center gap-1">
            <Badge variant={p.last_indexed ? 'success' : 'muted'}>
              {p.last_indexed ? t('common:status.indexed') : t('common:status.pending')}
            </Badge>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
              aria-label={t('projects:editProject')}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <CardTitle className="text-base mt-3 truncate">{p.name}</CardTitle>
        <CardDescription className="text-xs truncate font-mono">{p.root_path}</CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="flex items-center gap-2 text-muted-foreground">
            <FileCode2 className="h-3.5 w-3.5" />
            <span>
              <strong className="text-foreground">{p.file_count}</strong> {t('projects:files')}
            </span>
          </div>
          <div className="flex items-center gap-2 text-muted-foreground">
            <Boxes className="h-3.5 w-3.5" />
            <span>
              <strong className="text-foreground">{p.symbol_count}</strong> {t('projects:symbols')}
            </span>
          </div>
        </div>
        <div className="mt-3 pt-3 border-t flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="h-3 w-3" />
          {p.last_indexed ? formatRelativeTime(p.last_indexed) : t('projects:neverIndexed')}
        </div>
      </CardContent>
      {Menu}
    </Card>
  );
}
