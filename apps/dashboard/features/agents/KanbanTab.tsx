import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Loader2 } from 'lucide-react';
import { KanbanColumn } from './KanbanColumn.js';
import { KanbanCardModal } from './KanbanCardModal.js';
import { useKanbanState } from './useKanbanState.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import type {
  KanbanCardFull,
  KanbanColumn as KanbanColumnType,
  KanbanTag,
} from '@mcp/company/types.js';
import { KANBAN_COLUMNS } from '@mcp/company/types.js';

interface KanbanTabProps {
  companySessionId: number;
}

export function KanbanTab({ companySessionId }: KanbanTabProps) {
  const { t } = useTranslation(['agents', 'common']);
  const kanban = useKanbanState(companySessionId);
  const [selectedCard, setSelectedCard] = useState<KanbanCardFull | null>(null);
  const [createDialog, setCreateDialog] = useState<{ open: boolean; column: KanbanColumnType }>({
    open: false,
    column: 'backlog',
  });
  const [newTitle, setNewTitle] = useState('');
  const [newTag, setNewTag] = useState<KanbanTag | ''>('');

  // Group cards by column
  const cardsByColumn = new Map<KanbanColumnType, KanbanCardFull[]>();
  for (const col of KANBAN_COLUMNS) cardsByColumn.set(col, []);
  for (const card of kanban.cards) {
    const list = cardsByColumn.get(card.column) ?? [];
    list.push(card);
    cardsByColumn.set(card.column, list);
  }

  const handleDrop = useCallback(
    (cardId: number, column: KanbanColumnType) => {
      kanban.moveCard(cardId, column);
    },
    [kanban.moveCard],
  );

  const handleCardClick = useCallback((card: KanbanCardFull) => {
    setSelectedCard(card);
  }, []);

  const handleCreateCard = useCallback(
    (column: KanbanColumnType) => {
      setCreateDialog({ open: true, column });
      setNewTitle('');
      setNewTag('');
    },
    [],
  );

  const handleCreateSubmit = useCallback(async () => {
    if (!newTitle.trim()) return;
    await kanban.createCard({
      title: newTitle.trim(),
      column: createDialog.column,
      tag: newTag || undefined,
    });
    setCreateDialog({ open: false, column: 'backlog' });
  }, [newTitle, newTag, createDialog.column, kanban.createCard]);

  // Keep selectedCard in sync with kanban state
  const activeCard = selectedCard
    ? kanban.cards.find((c) => c.id === selectedCard.id) ?? selectedCard
    : null;

  if (kanban.loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Error banner */}
      {kanban.error && (
        <div className="mx-3 mt-2 p-2 bg-red-500/10 border border-red-500/30 rounded text-sm text-red-400">
          {kanban.error}
        </div>
      )}

      {/* Columns */}
      <div className="flex-1 overflow-x-auto p-3">
        <div className="flex gap-3 h-full min-h-0">
          {KANBAN_COLUMNS.map((col) => (
            <KanbanColumn
              key={col}
              column={col}
              cards={cardsByColumn.get(col) ?? []}
              onCardClick={handleCardClick}
              onDrop={handleDrop}
              onCreateCard={handleCreateCard}
            />
          ))}
        </div>
      </div>

      {/* Card detail modal */}
      {activeCard && (
        <KanbanCardModal
          card={activeCard}
          allCards={kanban.cards}
          open={!!activeCard}
          onClose={() => setSelectedCard(null)}
          onUpdate={kanban.updateCard}
          onAddComment={kanban.addComment}
          onAddChecklistItem={kanban.addChecklistItem}
          onUpdateChecklistItem={kanban.updateChecklistItem}
          onAddDependency={kanban.addDependency}
          onRemoveDependency={kanban.removeDependency}
          onDelete={kanban.deleteCard}
        />
      )}

      {/* Create card dialog */}
      <Dialog
        open={createDialog.open}
        onOpenChange={(v) => !v && setCreateDialog({ open: false, column: 'backlog' })}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('agents:kanban.newCard')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder={t('agents:kanban.cardTitlePlaceholder')}
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateSubmit()}
              autoFocus
            />
            <div className="flex gap-1">
              {(['bug', 'feature', 'refactor', 'documentation'] as KanbanTag[]).map((tag) => (
                <button
                  key={tag}
                  onClick={() => setNewTag(newTag === tag ? '' : tag)}
                  className={`text-xs px-2 py-1 rounded-full border transition-colors ${
                    newTag === tag
                      ? 'bg-primary/20 border-primary text-primary'
                      : 'border-border text-muted-foreground hover:border-primary/40'
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCreateDialog({ open: false, column: 'backlog' })}
              >
                {t('common:actions.cancel')}
              </Button>
              <Button size="sm" disabled={!newTitle.trim()} onClick={handleCreateSubmit}>
                <Plus className="h-3.5 w-3.5 mr-1" />
                {t('common:actions.create')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
