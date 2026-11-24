import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckSquare, Square, Plus, X, Link2, Unlink, Users, Clock,
  MessageSquare, Tag, ArrowRight,
} from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { confirm } from '../../components/ui/prompt-dialog.js';
import { WorkBoardBadge, WorkBoardDetailDialog } from '../../components/work-board/index.js';
import { formatDateTime } from '../../lib/datetime.js';
import { CardControl } from './design/CardControl.js';
import { KanbanDispatchReview } from './KanbanDispatchReview.js';
import type {
  KanbanCardFull,
  KanbanTag,
  KanbanColumn,
} from '@mcp/company/types.js';

const TAG_OPTIONS: KanbanTag[] = ['bug', 'feature', 'refactor', 'documentation'];
const TAG_COLORS: Record<string, string> = {
  bug: 'bg-red-500/20 text-red-400',
  feature: 'bg-blue-500/20 text-blue-400',
  refactor: 'bg-yellow-500/20 text-yellow-400',
  documentation: 'bg-green-500/20 text-green-400',
};

const COLUMN_LABEL_KEYS: Record<KanbanColumn, string> = {
  backlog: 'kanban.columns.backlog',
  todo: 'kanban.columns.todo',
  in_progress: 'kanban.columns.inProgress',
  review: 'kanban.columns.review',
  done: 'kanban.columns.done',
};

interface KanbanCardModalProps {
  onValidations?: () => void;
  companySessionId: string;
  onRefresh: () => void;
  card: KanbanCardFull;
  allCards: KanbanCardFull[];
  open: boolean;
  onClose: () => void;
  onUpdate: (cardId: string, patch: { title?: string; description?: string; tag?: KanbanTag | null }) => Promise<boolean>;
  onAddComment: (cardId: string, content: string) => Promise<boolean>;
  onAddChecklistItem: (cardId: string, text: string) => Promise<boolean>;
  onUpdateChecklistItem: (itemId: string, patch: { text?: string; checked?: boolean }) => Promise<boolean>;
  onAddDependency: (cardId: string, dependsOnCardId: string) => Promise<boolean>;
  onRemoveDependency: (cardId: string, dependsOnCardId: string) => Promise<boolean>;
  onDelete: (cardId: string) => Promise<boolean>;
}

export function KanbanCardModal({
  companySessionId,
  onValidations,
  onRefresh,
  card,
  allCards,
  open,
  onClose,
  onUpdate,
  onAddComment,
  onAddChecklistItem,
  onUpdateChecklistItem,
  onAddDependency,
  onRemoveDependency,
  onDelete,
}: KanbanCardModalProps) {
  const { t } = useTranslation(['agents', 'common']);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState(card.title);
  const [editingDesc, setEditingDesc] = useState(false);
  const [descValue, setDescValue] = useState(card.description);
  const [newCheckItem, setNewCheckItem] = useState('');
  const [newComment, setNewComment] = useState('');
  const [addingDep, setAddingDep] = useState(false);

  const checkedCount = card.checklist.filter((i) => i.checked).length;
  const existingDepIds = new Set(card.dependencies.map((d) => d.depends_on_id));
  const availableDeps = allCards.filter((c) => c.id !== card.id && !existingDepIds.has(c.id));

  return (
    <WorkBoardDetailDialog
      open={open}
      onClose={onClose}
      badges={<><WorkBoardBadge>#{card.id}</WorkBoardBadge><WorkBoardBadge tone={card.column === 'done' ? 'green' : card.column === 'review' ? 'violet' : 'blue'}>{t(`agents:${COLUMN_LABEL_KEYS[card.column]}`)}</WorkBoardBadge>{card.blocked_by.length > 0 && <WorkBoardBadge tone="red">{t('agents:kanban.card.blocked')}</WorkBoardBadge>}</>}
      title={editingTitle ? (
        <Input
          value={titleValue}
          onChange={(e) => setTitleValue(e.target.value)}
          onKeyDown={async (e) => {
            if (e.key === 'Enter') { await onUpdate(card.id, { title: titleValue }); setEditingTitle(false); }
            if (e.key === 'Escape') { setTitleValue(card.title); setEditingTitle(false); }
          }}
          autoFocus
          className="text-lg font-semibold"
        />
      ) : <button type="button" className="text-left transition-colors hover:text-primary" onClick={() => setEditingTitle(true)}>{card.title}</button>}
      footer={<><span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{t('agents:kanban.card.createdBy', { author: card.created_by, date: formatDateTime(card.created_at) })}</span><Button size="sm" variant="destructive" onClick={async () => { if (await confirm({ title: t('agents:kanban.card.deleteCard'), description: t('agents:kanban.card.deleteConfirm', { title: card.title }), confirmLabel: t('agents:kanban.card.deleteCard'), tone: 'destructive' })) { await onDelete(card.id); onClose(); } }}>{t('agents:kanban.card.deleteCard')}</Button></>}
    >

        <CardControl key={card.id} sessionId={companySessionId} card={card} onRefresh={onRefresh} onValidations={onValidations}/>
        <KanbanDispatchReview key={`${companySessionId}:${card.id}`} sessionId={companySessionId} cardId={card.id} onChanged={onRefresh} />

        {/* Tag selector */}
        <div className="flex items-center gap-2 mt-2">
          <Tag className="h-3.5 w-3.5 text-muted-foreground" />
          <div className="flex gap-1">
            {TAG_OPTIONS.map((tag) => (
              <button
                key={tag}
                onClick={() => onUpdate(card.id, { tag: card.tag === tag ? null : tag })}
                className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                  card.tag === tag
                    ? TAG_COLORS[tag] + ' border-current'
                    : 'text-muted-foreground border-border hover:border-primary/40'
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>

        {/* Description */}
        <div className="mt-4">
          <h4 className="text-sm font-medium mb-1">{t('agents:kanban.card.description')}</h4>
          {editingDesc ? (
            <div className="space-y-2">
              <Textarea
                value={descValue}
                onChange={(e) => setDescValue(e.target.value)}
                rows={4}
                autoFocus
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={async () => {
                    await onUpdate(card.id, { description: descValue });
                    setEditingDesc(false);
                  }}
                >
                  {t('agents:kanban.card.save')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDescValue(card.description);
                    setEditingDesc(false);
                  }}
                >
                  {t('common:actions.cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <div
              className="text-sm text-muted-foreground cursor-pointer hover:bg-muted/50 rounded p-2 min-h-[40px] whitespace-pre-wrap"
              onClick={() => setEditingDesc(true)}
            >
              {card.description || t('agents:kanban.card.clickToAddDesc')}
            </div>
          )}
        </div>

        {/* Checklist */}
        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-medium flex items-center gap-1.5">
              <CheckSquare className="h-4 w-4" />
              {t('agents:kanban.card.objectives')}
              {card.checklist.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  ({checkedCount}/{card.checklist.length})
                </span>
              )}
            </h4>
          </div>

          {/* Progress bar */}
          {card.checklist.length > 0 && (
            <div className="h-1.5 bg-muted rounded-full mb-2 overflow-hidden">
              <div
                className="h-full bg-green-500 transition-all"
                style={{ width: `${(checkedCount / card.checklist.length) * 100}%` }}
              />
            </div>
          )}

          <div className="space-y-1">
            {card.checklist
              .sort((a, b) => a.position - b.position)
              .map((item) => (
                <label
                  key={item.id}
                  className="flex items-center gap-2 p-1.5 rounded hover:bg-muted/50 cursor-pointer group"
                >
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      onUpdateChecklistItem(item.id, { checked: !item.checked });
                    }}
                    className="flex-shrink-0"
                  >
                    {item.checked ? (
                      <CheckSquare className="h-4 w-4 text-green-500" />
                    ) : (
                      <Square className="h-4 w-4 text-muted-foreground" />
                    )}
                  </button>
                  <span className={`text-sm flex-1 ${item.checked ? 'line-through text-muted-foreground' : ''}`}>
                    {item.text}
                  </span>
                </label>
              ))}
          </div>

          {/* Add checklist item */}
          <div className="flex gap-2 mt-2">
            <Input
              placeholder={t('agents:kanban.card.addObjective')}
              value={newCheckItem}
              onChange={(e) => setNewCheckItem(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === 'Enter' && newCheckItem.trim()) {
                  await onAddChecklistItem(card.id, newCheckItem.trim());
                  setNewCheckItem('');
                }
              }}
              className="text-sm"
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={!newCheckItem.trim()}
              onClick={async () => {
                if (newCheckItem.trim()) {
                  await onAddChecklistItem(card.id, newCheckItem.trim());
                  setNewCheckItem('');
                }
              }}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* Dependencies */}
        <div className="mt-4">
          <h4 className="text-sm font-medium flex items-center gap-1.5 mb-2">
            <Link2 className="h-4 w-4" />
            {t('agents:kanban.card.dependencies')}
          </h4>

          {card.dependencies.length > 0 && (
            <div className="space-y-1 mb-2">
              {card.dependencies.map((dep) => {
                const depCard = allCards.find((c) => c.id === dep.depends_on_id);
                const isBlocking = card.blocked_by.includes(dep.depends_on_id);
                return (
                  <div
                    key={dep.id}
                    className={`flex items-center gap-2 p-1.5 rounded text-sm ${
                      isBlocking ? 'bg-red-500/10 text-red-400' : 'bg-green-500/10 text-green-400'
                    }`}
                  >
                    <ArrowRight className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="flex-1">
                      #{dep.depends_on_id} {depCard?.title ?? 'Unknown'}
                      {isBlocking ? ' (blocking)' : ' (resolved)'}
                    </span>
                    <button
                      onClick={() => onRemoveDependency(card.id, dep.depends_on_id)}
                      className="p-0.5 rounded hover:bg-muted"
                    >
                      <Unlink className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {addingDep ? (
            <div className="space-y-1">
              {availableDeps.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('agents:kanban.card.noDeps')}</p>
              ) : (
                availableDeps.slice(0, 10).map((c) => (
                  <button
                    key={c.id}
                    onClick={async () => {
                      await onAddDependency(card.id, c.id);
                      setAddingDep(false);
                    }}
                    className="w-full text-left p-2 text-sm rounded hover:bg-muted/50 flex items-center gap-2"
                  >
                    <span className="text-muted-foreground">#{c.id}</span>
                    <span>{c.title}</span>
                    <Badge variant="outline" className="text-[10px] ml-auto">
                      {c.column}
                    </Badge>
                  </button>
                ))
              )}
              <Button size="sm" variant="ghost" onClick={() => setAddingDep(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setAddingDep(true)}>
              <Plus className="h-3.5 w-3.5 mr-1" /> {t('agents:kanban.card.addDependency')}
            </Button>
          )}
        </div>

        {/* Agent History */}
        {card.agents.length > 0 && (
          <div className="mt-4">
            <h4 className="text-sm font-medium flex items-center gap-1.5 mb-2">
              <Users className="h-4 w-4" />
              {t('agents:kanban.card.agentHistory')}
            </h4>
            <div className="space-y-1">
              {card.agents.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center gap-2 p-1.5 rounded bg-muted/30 text-sm"
                >
                  <div className={`w-2 h-2 rounded-full ${a.unassigned_at ? 'bg-muted-foreground' : 'bg-green-500'}`} />
                  <span className="font-medium">{a.role}</span>
                  <span className="text-muted-foreground text-xs">
                    {t('agents:kanban.card.run', { id: a.agent_run_id })}
                  </span>
                  <span className="text-muted-foreground text-xs ml-auto flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {formatDateTime(a.assigned_at)}
                    {a.unassigned_at && ` - ${formatDateTime(a.unassigned_at)}`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Comments */}
        <div className="mt-4">
          <h4 className="text-sm font-medium flex items-center gap-1.5 mb-2">
            <MessageSquare className="h-4 w-4" />
            {t('agents:kanban.card.comments', { count: card.comments.length })}
          </h4>

          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {card.comments.map((comment) => (
              <div
                key={comment.id}
                className="p-2.5 rounded-lg bg-muted/30 border border-border/50"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-medium">{comment.author_role}</span>
                  {comment.agent_run_id && (
                    <span className="text-[10px] text-muted-foreground">
                      run #{comment.agent_run_id}
                    </span>
                  )}
                  <span className="text-[10px] text-muted-foreground ml-auto">
                    {formatDateTime(comment.created_at)}
                  </span>
                </div>
                <p className="text-sm whitespace-pre-wrap">{comment.content}</p>
              </div>
            ))}
          </div>

          {/* Add comment */}
          <div className="flex gap-2 mt-2">
            <Textarea
              placeholder={t('agents:kanban.card.addComment')}
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              rows={2}
              className="text-sm"
            />
          </div>
          <div className="flex justify-end mt-1">
            <Button
              size="sm"
              disabled={!newComment.trim()}
              onClick={async () => {
                if (newComment.trim()) {
                  await onAddComment(card.id, newComment.trim());
                  setNewComment('');
                }
              }}
            >
              {t('agents:kanban.card.comment')}
            </Button>
          </div>
        </div>

    </WorkBoardDetailDialog>
  );
}
