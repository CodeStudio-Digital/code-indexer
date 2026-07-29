import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Network, X, Plus, Pencil } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover.js';
import { Button } from '../../../components/ui/button.js';
import { useApi } from '../../../hooks/useApi.js';
import { PipelineBuilder } from '../../agents/pipelines/PipelineBuilder.js';
import type { Pipeline } from '@mcp/company/types.js';

/**
 * Lightweight pipeline picker for the Composer toolbar.
 *
 * Shows the chip-style trigger; on click opens a popover listing
 * pipelines available to this chat session (`GET /api/coder/sessions/:id/pipelines`).
 * Selecting one calls `onChange(pipelineId)`. Selecting "None" clears.
 *
 * The composer flips its send button label when a pipeline is selected
 * and routes input to `POST /pipelines/:pid/start` instead of /messages.
 */
export interface PipelineSummary {
  id: number;
  name: string;
  description: string;
  version: number;
}

interface PipelinePickerProps {
  sessionId: string | null;
  selectedPipelineId: number | null;
  onChange: (pipelineId: number | null) => void;
  /**
   * When true, render the trigger as an icon-only button matching the
   * markdown toolbar's h-7 w-7 chip style — used when the picker sits
   * in the upper toolbar row alongside Bold/Italic/etc. Default `false`
   * preserves the chip-with-label style used in the legacy lower toolbar.
   */
  compact?: boolean;
}

export const PipelinePicker = React.memo(function PipelinePicker({
  sessionId,
  selectedPipelineId,
  onChange,
  compact,
}: PipelinePickerProps) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  // `undefined` = builder closed; `null` = creating a new pipeline; a
  // Pipeline = editing that one.
  const [editing, setEditing] = useState<Pipeline | null | undefined>(undefined);
  const url = sessionId ? `/coder/sessions/${sessionId}/pipelines` : '';
  const { data: pipelines, refetch } = useApi<Pipeline[]>(url);

  // Global skills feed the builder's per-node extraSkills picker (same
  // source the company builder uses).
  const skillsApi = useApi<{ skills: Array<{ id: string; enabled: boolean }> }>('/admin/skills');
  const availableSkills = useMemo(
    () => (skillsApi.data?.skills ?? []).filter((s) => s.enabled).map((s) => s.id),
    [skillsApi.data],
  );

  // If the selected pipeline disappears (deleted by user, scope filter
  // changed), clear selection so the send button flips back to chat mode.
  useEffect(() => {
    if (selectedPipelineId == null || !pipelines) return;
    const stillExists = pipelines.some((p) => p.id === selectedPipelineId);
    if (!stillExists) onChange(null);
  }, [pipelines, selectedPipelineId, onChange]);

  const selected = pipelines?.find((p) => p.id === selectedPipelineId) ?? null;

  return (
    <>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {compact ? (
          <button
            type="button"
            aria-label={
              selected
                ? t('pipelinePicker.activeTitle', { name: selected.name })
                : t('pipelinePicker.openTitle')
            }
            title={
              selected
                ? t('pipelinePicker.activeTitle', { name: selected.name })
                : t('pipelinePicker.openTitle')
            }
            className={`relative inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors ${
              selected
                ? 'text-info bg-info/10 hover:bg-info/20'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
          >
            <Network className="h-3.5 w-3.5" />
            {selected && (
              <span
                aria-hidden
                className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-info"
              />
            )}
          </button>
        ) : (
          <button
            type="button"
            className={`inline-flex items-center gap-1.5 h-8 px-2 rounded-md border text-xs transition-colors ${
              selected
                ? 'border-info/40 bg-info/10 text-info hover:bg-info/15'
                : 'border-input bg-background hover:bg-muted text-muted-foreground hover:text-foreground'
            }`}
            title={
              selected
                ? t('pipelinePicker.activeTitle', { name: selected.name })
                : t('pipelinePicker.openTitle')
            }
          >
            <Network className="h-3.5 w-3.5" />
            <span className="max-w-[110px] truncate">
              {selected ? selected.name : t('pipelinePicker.label')}
            </span>
            {selected && (
              <span
                role="button"
                aria-label={t('pipelinePicker.clear')}
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    onChange(null);
                  }
                }}
                className="ml-1 inline-flex items-center justify-center h-4 w-4 rounded hover:bg-info/20 cursor-pointer"
              >
                <X className="h-2.5 w-2.5" />
              </span>
            )}
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="start" side="top">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-2 py-1">
          {t('pipelinePicker.heading')}
        </div>
        {(!pipelines || pipelines.length === 0) ? (
          <div className="px-2 py-3 text-xs text-muted-foreground text-center">
            {t('pipelinePicker.empty')}
          </div>
        ) : (
          <div className="max-h-64 overflow-y-auto">
            {pipelines.map((p) => {
              const isActive = p.id === selectedPipelineId;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    onChange(p.id);
                    setOpen(false);
                  }}
                  className={`group w-full text-left px-2 py-1.5 rounded text-xs flex items-center gap-1.5 ${
                    isActive ? 'bg-info/15 text-info' : 'hover:bg-muted'
                  }`}
                >
                  <span className="flex flex-col gap-0.5 min-w-0 flex-1">
                    <span className="font-medium truncate">{p.name}</span>
                    {p.description && (
                      <span className="text-muted-foreground truncate text-[11px]">
                        {p.description}
                      </span>
                    )}
                  </span>
                  <span
                    role="button"
                    aria-label={t('pipelinePicker.edit', { defaultValue: 'Edit' })}
                    title={t('pipelinePicker.edit', { defaultValue: 'Edit' })}
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditing(p);
                      setOpen(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        setEditing(p);
                        setOpen(false);
                      }
                    }}
                    className="shrink-0 inline-flex items-center justify-center h-5 w-5 rounded opacity-0 group-hover:opacity-100 hover:bg-muted-foreground/20 cursor-pointer"
                  >
                    <Pencil className="h-3 w-3" />
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <div className="border-t mt-2 pt-2 space-y-1">
          <Button
            size="sm"
            variant="ghost"
            className="w-full text-xs justify-start"
            onClick={() => {
              setEditing(null);
              setOpen(false);
            }}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            {t('pipelinePicker.newPipeline', { defaultValue: 'New pipeline' })}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="w-full text-xs"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            disabled={selectedPipelineId == null}
          >
            {t('pipelinePicker.clearSelection')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>

    {editing !== undefined && sessionId != null && (
      <div className="fixed inset-0 z-50">
        <PipelineBuilder
          scope={{ kind: 'project', coderSessionId: sessionId }}
          pipeline={editing}
          availableRoles={[]}
          availableSkills={availableSkills}
          onClose={() => setEditing(undefined)}
          onSaved={(saved) => {
            setEditing(undefined);
            refetch();
            onChange(saved.id);
          }}
        />
      </div>
    )}
    </>
  );
});
