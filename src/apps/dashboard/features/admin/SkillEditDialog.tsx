import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Switch } from '../../components/ui/switch.js';
import type { AdminSkill, SkillContextMode } from './skills-api.js';

interface SkillEditDialogProps {
  initial: Partial<AdminSkill>;
  isExisting: boolean;
  onClose: () => void;
  onSave: (s: Partial<AdminSkill>) => void;
}

const CONTEXT_MODES: { value: SkillContextMode; label: string; desc: string }[] = [
  { value: 'inline', label: 'Inline', desc: 'Injected into system prompt' },
  { value: 'tool', label: 'Tool', desc: 'Callable by the model via invoke_skill' },
  { value: 'both', label: 'Both', desc: 'System prompt + callable tool' },
];

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

export function SkillEditDialog({ initial, isExisting, onClose, onSave }: SkillEditDialogProps) {
  const isNew = !isExisting;
  const [form, setForm] = useState<Partial<AdminSkill>>({
    context_mode: 'inline',
    scope: 'global',
    enabled: true,
    sort_order: 0,
    tags: [],
    variables: [],
    version: '1.0.0',
    source: 'user',
    ...initial,
  });
  const [autoId, setAutoId] = useState(isNew);

  function update<K extends keyof AdminSkill>(k: K, v: AdminSkill[K] | null) {
    setForm((f) => {
      const next = { ...f, [k]: v };
      // Auto-generate ID from name for new skills
      if (k === 'name' && autoId) {
        next.id = slugify(v as string);
      }
      return next;
    });
  }

  function submit() {
    onSave({
      id: form.id,
      name: form.name,
      description: form.description || '',
      slash_command: form.slash_command || null,
      prompt_body: form.prompt_body,
      scope: form.scope || 'global',
      enabled: form.enabled ?? true,
      allowed_tools: form.allowed_tools,
      model_override: form.model_override || null,
      provider_override: form.provider_override || null,
      context_mode: form.context_mode || 'inline',
      sort_order: form.sort_order ?? 0,
      tags: form.tags ?? [],
      path_patterns: form.path_patterns,
      author: form.author || null,
      version: form.version || '1.0.0',
      source: form.source || 'user',
    });
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isNew ? 'Create Skill' : `Edit "${form.name}"`}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Name */}
          <div>
            <label className="text-sm font-medium">Name</label>
            <Input
              value={form.name ?? ''}
              onChange={(e) => update('name', e.target.value)}
              placeholder="Simplify Code"
            />
          </div>

          {/* ID */}
          <div>
            <label className="text-sm font-medium">ID</label>
            <div className="flex items-center gap-2">
              <Input
                value={form.id ?? ''}
                onChange={(e) => { setAutoId(false); setForm((f) => ({ ...f, id: e.target.value })); }}
                placeholder="simplify-code"
                disabled={isExisting}
                className="font-mono text-sm"
              />
              {isNew && (
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {autoId ? 'auto' : 'manual'}
                </span>
              )}
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="text-sm font-medium">Description</label>
            <Input
              value={form.description ?? ''}
              onChange={(e) => update('description', e.target.value)}
              placeholder="Review code for reuse, quality, and efficiency"
            />
          </div>

          {/* Slash command */}
          <div>
            <label className="text-sm font-medium">Slash Command</label>
            <div className="flex items-center gap-1">
              <span className="text-sm text-muted-foreground">/</span>
              <Input
                value={form.slash_command ?? ''}
                onChange={(e) => update('slash_command', e.target.value || null)}
                placeholder="simplify"
                className="font-mono text-sm"
              />
            </div>
          </div>

          {/* Prompt body */}
          <div>
            <label className="text-sm font-medium">Prompt Body</label>
            <p className="text-xs text-muted-foreground mb-1">
              Markdown instructions. Use {'${PROJECT_NAME}'}, {'${SESSION_ID}'}, {'${USER_INPUT}'}, {'${OS}'}, {'${TIMESTAMP}'} as template variables.
            </p>
            <Textarea
              value={form.prompt_body ?? ''}
              onChange={(e) => update('prompt_body', e.target.value)}
              placeholder="Review the current codebase changes for..."
              rows={10}
              className="font-mono text-sm"
            />
          </div>

          {/* Context mode */}
          <div>
            <label className="text-sm font-medium">Context Mode</label>
            <Select
              value={form.context_mode ?? 'inline'}
              onValueChange={(v) => update('context_mode', v as SkillContextMode)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTEXT_MODES.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label} — {m.desc}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Scope */}
          <div>
            <label className="text-sm font-medium">Scope</label>
            <Input
              value={form.scope ?? 'global'}
              onChange={(e) => update('scope', e.target.value)}
              placeholder="global (or project_id)"
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Use "global" for all projects, or a numeric project ID to scope to one project.
            </p>
          </div>

          {/* Tags */}
          <div>
            <label className="text-sm font-medium">Tags</label>
            <Input
              value={(form.tags ?? []).join(', ')}
              onChange={(e) => update('tags', e.target.value.split(',').map((t) => t.trim()).filter(Boolean))}
              placeholder="review, quality, testing"
            />
          </div>

          {/* Sort order */}
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label className="text-sm font-medium">Sort Order</label>
              <Input
                type="number"
                value={form.sort_order ?? 0}
                onChange={(e) => update('sort_order', parseInt(e.target.value, 10) || 0)}
              />
            </div>
            <div className="flex items-center gap-2 pt-5">
              <Switch
                checked={form.enabled ?? true}
                onCheckedChange={(v) => update('enabled', v)}
              />
              <label className="text-sm">Enabled</label>
            </div>
          </div>

          {/* Model override */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium">Provider Override</label>
              <Input
                value={form.provider_override ?? ''}
                onChange={(e) => update('provider_override', e.target.value || null)}
                placeholder="(session default)"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Model Override</label>
              <Input
                value={form.model_override ?? ''}
                onChange={(e) => update('model_override', e.target.value || null)}
                placeholder="(session default)"
              />
            </div>
          </div>

          {/* Allowed tools */}
          <div>
            <label className="text-sm font-medium">Allowed Tools</label>
            <Input
              value={(form.allowed_tools ?? []).join(', ')}
              onChange={(e) => {
                const val = e.target.value;
                update('allowed_tools', val ? val.split(',').map((t) => t.trim()).filter(Boolean) : null);
              }}
              placeholder="(all tools — or comma-separated list)"
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Leave empty for no restriction. Comma-separated tool names to limit.
            </p>
          </div>

          {/* Author + Version */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium">Author</label>
              <Input
                value={form.author ?? ''}
                onChange={(e) => update('author', e.target.value || null)}
                placeholder="Your name"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Version</label>
              <Input
                value={form.version ?? '1.0.0'}
                onChange={(e) => update('version', e.target.value)}
                placeholder="1.0.0"
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={submit}
            disabled={!form.id || !form.name || !form.prompt_body}
          >
            {isNew ? 'Create' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
