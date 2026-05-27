import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, FileText, Maximize2, Paperclip, Sparkles, X } from 'lucide-react';
import { Textarea } from '../../../components/ui/textarea.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip.js';
import { useConfirm } from '../../../components/ui/dialog-provider.js';
import type { AgentAttachment, EnrichedProviderModel, ProviderOption } from '../types.js';
import { fileToAttachment } from '../utils.js';
import { ComposerToolbar } from './ComposerToolbar.js';
import { MarkdownToolbar } from './MarkdownToolbar.js';
import { PipelinePicker } from './PipelinePicker.js';
import { useMarkdownShortcuts } from './useMarkdownShortcuts.js';

interface SlashCommand {
  id: string;
  command: string;
  name: string;
  description: string;
  context_mode: string;
}

type AgentId = 'explore' | 'plan' | 'build' | 'admin' | 'spec';

// Visual cue: tints the composer's left border by the active mode so the
// user sees-at-a-glance which agent is loaded. The functional gates
// (confirm-before-irreversible, tier filtering) live in the runner.
const BORDER_TINT: Record<AgentId, string> = {
  explore: 'border-l-sky-500',
  plan: 'border-l-violet-500',
  build: 'border-l-emerald-500',
  admin: 'border-l-rose-500',
  spec: 'border-l-amber-500',
};

export interface ComposerHandle {
  setInput: (v: string) => void;
}

interface ComposerProps {
  onSend: (text: string, attachments: AgentAttachment[], selectedSkillIds?: string[]) => void;
  onAbort: () => void;
  streaming: boolean;
  /** Project file paths chosen in the sidebar; injected into the prompt
   *  as a `<file_refs>` block on send and cleared via `onClearPicks`. */
  filePicks?: string[];
  onRemovePick?: (path: string) => void;
  onClearPicks?: () => void;
  /** Skill ids chosen in the sidebar; forwarded to the server which prepends
   *  their interpolated prompt bodies inside an `<active_skills>` block on
   *  the user message. Cleared via `onClearSkillPicks` after send. */
  skillPicks?: string[];
  onRemoveSkillPick?: (id: string) => void;
  onClearSkillPicks?: () => void;
  agent: AgentId;
  setAgent: (v: AgentId) => void;
  provider: string;
  model: string;
  setModel: (v: string) => void;
  onSwitchProvider: (p: string, m: string) => void;
  providerOptions: ProviderOption[];
  currentProviderModels: EnrichedProviderModel[];
  maxTurns: number | null;
  setMaxTurns: (v: number | null) => void;
  /** Per-session temperature override. `null` = inherit from role/agent/default. */
  temperature: number | null;
  setTemperature: (v: number | null) => void;
  /**
   * Per-session "unrestricted tool output" toggle (migration 078). When true,
   * the runner / mcp-bridge / code_exec lift their per-tool-call truncation
   * caps to a high safety ceiling (≈1 MB). Useful for Unity / large file
   * reads. Auto-compaction still runs.
   */
  unrestrictedOutput?: boolean;
  setUnrestrictedOutput?: (v: boolean) => void;
  sessionId?: number | null;
  onInvokeSkill?: (skillId: string, input: string) => void;
  /** Thinking mode toggle — only shown when provider supports it. */
  thinking?: boolean;
  setThinking?: (v: boolean) => void;
  supportsThinking?: boolean;
  /** Simulated deepThink toggle — auxiliary cheap model writes a pre-thought
   *  before each main-model turn. Orthogonal to `thinking`. */
  deepThink?: boolean;
  setDeepThink?: (v: boolean) => void;
  /** Fallback configuration. */
  fallbackProvider?: string | null;
  fallbackModel?: string | null;
  onFallbackChange?: (provider: string | null, model: string | null) => void;
  getModelsForProvider?: (providerId: string) => EnrichedProviderModel[];
  /**
   * When set, the send button flips to "Run pipeline" and `onRunPipeline`
   * receives the input text. Pipeline mode bypasses the chat /messages
   * endpoint and posts to `/api/coder/sessions/:id/pipelines/:pid/start`.
   */
  selectedPipelineId?: number | null;
  setSelectedPipelineId?: (v: number | null) => void;
  onRunPipeline?: (pipelineId: number, initialInput: string) => Promise<void> | void;
}

export const Composer = React.forwardRef<ComposerHandle, ComposerProps>(
  function Composer(props, ref) {
    const { t } = useTranslation('chat');
    const { streaming } = props;
    const [input, setInput] = useState('');
    const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const { handleKeyDown: mdKeyDown, applyAction } = useMarkdownShortcuts(textareaRef, input, setInput);
    const confirm = useConfirm();

    // Debounced value for AgentPicker auto-suggest (avoids re-rendering toolbar on every keystroke)
    const [debouncedInput, setDebouncedInput] = useState('');
    useEffect(() => {
      const h = setTimeout(() => setDebouncedInput(input), 300);
      return () => clearTimeout(h);
    }, [input]);

    // ─── Slash command autocomplete ─────────────────────────────
    const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
    const [showSlash, setShowSlash] = useState(false);
    const [slashIndex, setSlashIndex] = useState(0);

    // Load available slash commands once
    useEffect(() => {
      fetch('/api/coder/skills/slash-commands')
        .then((r) => r.json())
        .then((data: { commands: SlashCommand[] }) => setSlashCommands(data.commands))
        .catch(() => {});
    }, []);

    // Filter slash commands based on current input
    const slashPrefix = input.startsWith('/') ? input.slice(1).split(/\s/)[0].toLowerCase() : '';
    const filteredSlash = input.startsWith('/') && !input.includes(' ')
      ? slashCommands.filter((c) => c.command.toLowerCase().startsWith(slashPrefix))
      : [];

    useEffect(() => {
      setShowSlash(filteredSlash.length > 0 && input.startsWith('/') && !input.includes(' '));
      setSlashIndex(0);
    }, [input]);

    useImperativeHandle(ref, () => ({ setInput }), []);

    const handleFiles = useCallback(async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const arr = await Promise.all(Array.from(files).map(fileToAttachment));
      setAttachments((prev) => [...prev, ...arr]);
    }, []);

    // Auto-resize textarea based on content
    useEffect(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.style.height = 'auto';
      const minH = 72;  // ~3 rows
      const maxH = 288; // ~12 rows
      ta.style.height = `${Math.min(Math.max(ta.scrollHeight, minH), maxH)}px`;
    }, [input]);

    const onPaste = useCallback(async (e: React.ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const files = items
        .filter((it) => it.kind === 'file')
        .map((it) => it.getAsFile())
        .filter((f): f is File => !!f);
      if (files.length === 0) return;
      e.preventDefault();
      const renamed = files.map((f) => {
        if (f.name && f.name !== 'image.png') return f;
        const ext = (f.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
        return new File([f], `pasted-${Date.now()}.${ext}`, { type: f.type });
      });
      const dt = new DataTransfer();
      renamed.forEach((f) => dt.items.add(f));
      await handleFiles(dt.files);
    }, [handleFiles]);

    const hasInput = input.trim().length > 0;

    const handleSend = useCallback(async () => {
      if (!input.trim()) return;

      // Admin send-gate (friction-only). Real safety is the runner's
      // confirmBeforeIrreversible — this is just a heads-up on first send.
      // Suppressed after the user dismisses it once per browser session.
      if (props.agent === 'admin' && sessionStorage.getItem('admin-mode-ack') !== 'yes') {
        const ok = await confirm({
          title: 'Send to Admin mode?',
          description: 'Mutating tools (git_commit, snapshot mutations, indexing) are unlocked. The runner will still ask before each destructive call.',
          confirmLabel: 'Send',
          cancelLabel: 'Cancel',
          variant: 'warning',
        });
        if (!ok) return;
        sessionStorage.setItem('admin-mode-ack', 'yes');
      }

      const text = input;
      const picks = props.filePicks ?? [];
      const skillIds = props.skillPicks ?? [];

      // Pipeline mode: route the raw input to the pipeline starter
      // instead of the chat /messages endpoint. Picks and attachments
      // aren't forwarded — pipelines are always text-driven for MVP.
      if (props.selectedPipelineId != null && props.onRunPipeline) {
        const pid = props.selectedPipelineId;
        setInput('');
        setAttachments([]);
        props.onClearPicks?.();
        props.onClearSkillPicks?.();
        void props.onRunPipeline(pid, text);
        return;
      }

      // Intercept slash commands: /command args → invoke skill
      if (text.startsWith('/') && props.onInvokeSkill && props.sessionId) {
        const spaceIdx = text.indexOf(' ');
        const cmd = spaceIdx > 0 ? text.slice(1, spaceIdx) : text.slice(1);
        const args = spaceIdx > 0 ? text.slice(spaceIdx + 1).trim() : '';
        const match = slashCommands.find((c) => c.command.toLowerCase() === cmd.toLowerCase());
        if (match) {
          setInput('');
          setAttachments([]);
          props.onClearPicks?.();
          props.onClearSkillPicks?.();
          props.onInvokeSkill(match.id, args);
          return;
        }
      }

      const finalText = picks.length > 0
        ? `<file_refs>\n${picks.map((p) => `- ${p}`).join('\n')}\n</file_refs>\n\n${text}`
        : text;
      const atts = attachments;
      setInput('');
      setAttachments([]);
      props.onClearPicks?.();
      props.onClearSkillPicks?.();
      props.onSend(finalText, atts, skillIds.length > 0 ? skillIds : undefined);
    }, [input, attachments, slashCommands, props.agent, props.onSend, props.onInvokeSkill, props.sessionId, props.filePicks, props.onClearPicks, props.skillPicks, props.onClearSkillPicks, props.selectedPipelineId, props.onRunPipeline, confirm]);

    const filePicks = props.filePicks ?? [];
    const PICKS_VISIBLE = 3;
    const visiblePicks = filePicks.slice(0, PICKS_VISIBLE);
    const overflowPicks = filePicks.slice(PICKS_VISIBLE);
    const [picksOpen, setPicksOpen] = useState(false);
    const picksRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
      if (!picksOpen) return;
      const onDocClick = (e: MouseEvent) => {
        if (picksRef.current && !picksRef.current.contains(e.target as Node)) {
          setPicksOpen(false);
        }
      };
      document.addEventListener('mousedown', onDocClick);
      return () => document.removeEventListener('mousedown', onDocClick);
    }, [picksOpen]);

    const skillPicks = props.skillPicks ?? [];

    return (
      <div className="border-t bg-card p-4">
        {(attachments.length > 0 || filePicks.length > 0 || skillPicks.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 mb-3">
            {skillPicks.map((id) => (
              <div
                key={`skill-${id}`}
                className="group inline-flex items-center gap-1 h-6 pl-1.5 pr-1 rounded-md border border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400 text-[11px] max-w-[180px]"
                title={id}
              >
                <Sparkles className="h-3 w-3 shrink-0" />
                <span className="truncate">{id}</span>
                <button
                  type="button"
                  onClick={() => props.onRemoveSkillPick?.(id)}
                  className="shrink-0 p-0.5 rounded hover:bg-violet-500/20 text-violet-500/70 hover:text-violet-600 dark:hover:text-violet-300"
                  title={t('composer.remove')}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            ))}
            {visiblePicks.map((p) => {
              const name = p.split('/').pop() ?? p;
              return (
                <div key={`pick-${p}`} className="group inline-flex items-center gap-1 h-6 pl-1.5 pr-1 rounded-md border border-info/30 bg-info/10 text-info text-[11px] max-w-[180px]" title={p}>
                  <FileText className="h-3 w-3 shrink-0" />
                  <span className="truncate">{name}</span>
                  <button
                    type="button"
                    onClick={() => props.onRemovePick?.(p)}
                    className="shrink-0 p-0.5 rounded hover:bg-info/20 text-info/70 hover:text-info"
                    title={t('composer.remove')}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
              );
            })}
            {overflowPicks.length > 0 && (
              <div className="relative" ref={picksRef}>
                <button
                  type="button"
                  onClick={() => setPicksOpen((v) => !v)}
                  className="inline-flex items-center h-6 px-2 rounded-md border border-info/30 bg-info/10 text-info text-[11px] hover:bg-info/20"
                >
                  {t('composer.morePicks', { count: overflowPicks.length })}
                </button>
                {picksOpen && (
                  <div className="absolute bottom-full left-0 mb-1 z-50 w-64 max-h-64 overflow-y-auto rounded-lg border bg-popover text-popover-foreground shadow-md p-1">
                    <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                      {t('composer.allPicks')} ({filePicks.length})
                    </div>
                    {filePicks.map((p) => {
                      const name = p.split('/').pop() ?? p;
                      return (
                        <div key={`menu-${p}`} className="group flex items-center gap-1.5 px-2 py-1 text-[11px] rounded hover:bg-muted/60" title={p}>
                          <FileText className="h-3 w-3 shrink-0 text-info" />
                          <span className="truncate flex-1 min-w-0">{name}</span>
                          <button
                            type="button"
                            onClick={() => props.onRemovePick?.(p)}
                            className="shrink-0 p-0.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                            title={t('composer.remove')}
                          >
                            <X className="h-2.5 w-2.5" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {attachments.map((a, i) => {
              const isImg = a.mediaType.startsWith('image/') && a.base64;
              return (
                <div key={i} className="relative group">
                  {isImg ? (
                    <img
                      src={`data:${a.mediaType};base64,${a.base64}`}
                      alt={a.name}
                      className="h-16 w-16 object-cover rounded-lg border"
                    />
                  ) : (
                    <div className="h-16 px-3 flex items-center text-xs rounded-lg border bg-muted gap-1.5">
                      <Paperclip className="h-3 w-3" />
                      {a.name}
                    </div>
                  )}
                  <button
                    onClick={() => setAttachments((p) => p.filter((_, j) => j !== i))}
                    className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow"
                    title={t('composer.remove')}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className={`relative rounded-xl border border-l-2 ${BORDER_TINT[props.agent] ?? ''} bg-background shadow-sm focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background transition`}>
          {/* Slash command autocomplete dropdown */}
          {showSlash && filteredSlash.length > 0 && (
            <div className="absolute bottom-full left-0 right-0 mb-1 z-50 rounded-lg border bg-popover text-popover-foreground shadow-md max-h-48 overflow-auto">
              {filteredSlash.map((cmd, i) => (
                <button
                  key={cmd.id}
                  type="button"
                  className={`flex items-center gap-2 w-full px-3 py-2 text-left text-sm hover:bg-muted transition-colors ${i === slashIndex ? 'bg-muted' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setInput(`/${cmd.command} `);
                    setShowSlash(false);
                    textareaRef.current?.focus();
                  }}
                >
                  <Sparkles className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="font-mono text-xs font-medium">/{cmd.command}</span>
                  <span className="text-xs text-muted-foreground truncate">{cmd.name}</span>
                  {cmd.description && (
                    <span className="text-xs text-muted-foreground/60 truncate ml-auto">
                      {cmd.description}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              // Slash command navigation
              if (showSlash && filteredSlash.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSlashIndex((i) => Math.min(i + 1, filteredSlash.length - 1));
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSlashIndex((i) => Math.max(i - 1, 0));
                  return;
                }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.metaKey && !e.ctrlKey)) {
                  e.preventDefault();
                  const cmd = filteredSlash[slashIndex];
                  if (cmd) setInput(`/${cmd.command} `);
                  setShowSlash(false);
                  return;
                }
                if (e.key === 'Escape') {
                  setShowSlash(false);
                  return;
                }
              }
              // Highest priority: send message
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSend();
                return;
              }
              // Markdown shortcuts and smart behaviors
              mdKeyDown(e);
            }}
            placeholder={t('composer.placeholder')}
            rows={3}
            disabled={streaming}
            className="border-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 bg-transparent text-sm min-h-0"
          />
          {/*
            Markdown formatting toolbar + a slot on the right for the
            "session-level" icons (attachment / pipeline / think /
            deepthink / cap). Tucking them up here keeps the busier
            bottom row focused on pickers (agent / provider / model)
            and the Send button.
          */}
          <div className="flex items-center">
            <MarkdownToolbar
              onAction={applyAction}
              disabled={streaming}
              rightSlot={
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <label className="cursor-pointer">
                        <input
                          type="file"
                          multiple
                          accept="image/*,.pdf,.txt,.md,.json,.csv,.yaml,.yml,.xml,.html,.ts,.tsx,.js,.jsx,.py,.go,.rs,.java,.sh,.sql,.toml,.ini,.log"
                          className="hidden"
                          onChange={(e) => {
                            handleFiles(e.target.files);
                            e.target.value = '';
                          }}
                          disabled={streaming}
                        />
                        <span
                          className={`inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors ${
                            streaming
                              ? 'text-muted-foreground/40 cursor-not-allowed'
                              : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                          }`}
                        >
                          <Paperclip className="h-3.5 w-3.5" />
                        </span>
                      </label>
                    </TooltipTrigger>
                    <TooltipContent side="top">{t('composer.attach', { defaultValue: 'Anexar arquivos' })}</TooltipContent>
                  </Tooltip>

                  {props.setSelectedPipelineId && (
                    <PipelinePicker
                      sessionId={props.sessionId ?? null}
                      selectedPipelineId={props.selectedPipelineId ?? null}
                      onChange={props.setSelectedPipelineId}
                      compact
                    />
                  )}

                  {/* Thinking icon. Active when the toggle is on. Only
                      enabled when the active provider/model supports it
                      (provider-caps.ts); rendered greyed out otherwise so
                      the user knows the feature exists. */}

                    {/*disabled={!props.supportsThinking}*/}
                  {props.setThinking && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => props.setThinking?.(!props.thinking)}

                          aria-pressed={props.thinking ?? false}
                          className={`relative inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                            props.thinking
                              ? 'bg-purple-500/15 text-purple-500 hover:bg-purple-500/25'
                              : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                          }`}
                        >
                          <Brain className="h-3.5 w-3.5" />
                          {props.thinking && (
                            <span aria-hidden className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-purple-500" />
                          )}
                        </button>
                      </TooltipTrigger>
                      {/*<TooltipContent side="top" className="max-w-[260px]">
                        {props.supportsThinking
                          ? t('toolbar.thinking', {
                              defaultValue:
                                'Extended thinking: o modelo raciocina passo-a-passo antes de responder. Mais lento e mais caro nos tiers Pro/Opus; ganho em problemas difíceis.',
                            })
                          : t('toolbar.thinkingUnsupported', {
                              defaultValue: 'O modelo atual não suporta extended thinking.',
                            })}
                      </TooltipContent>*/}
                    </Tooltip>
                  )}

                  {/* deepThink (simulated) — orthogonal to thinking */}
                  {props.setDeepThink && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => props.setDeepThink?.(!props.deepThink)}
                          aria-pressed={props.deepThink ?? false}
                          className={`relative inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors ${
                            props.deepThink
                              ? 'bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25'
                              : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                          }`}
                        >
                          <Sparkles className="h-3.5 w-3.5" />
                          {props.deepThink && (
                            <span aria-hidden className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-emerald-500" />
                          )}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-[260px]">
                        {t('toolbar.deepThink', {
                          defaultValue:
                            'deepThink (simulado): um modelo auxiliar barato (Haiku) escreve um pré-pensamento antes de cada turno do modelo principal. Ortogonal a "think". Custo extra pequeno, ganho em raciocínio.',
                        })}
                      </TooltipContent>
                    </Tooltip>
                  )}

                  {/* Unrestricted-tool-output (cap / full) */}
                  {props.setUnrestrictedOutput && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => props.setUnrestrictedOutput?.(!props.unrestrictedOutput)}
                          aria-pressed={props.unrestrictedOutput ?? false}
                          className={`relative inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors ${
                            props.unrestrictedOutput
                              ? 'bg-amber-500/15 text-amber-500 hover:bg-amber-500/25'
                              : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                          }`}
                        >
                          <Maximize2 className="h-3.5 w-3.5" />
                          {props.unrestrictedOutput && (
                            <span aria-hidden className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-amber-500" />
                          )}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-[260px]">
                        {t('toolbar.unrestrictedOutput', {
                          defaultValue:
                            'Tool output: full. Eleva o cap de truncação por tool-call de ~24 KB para ~1 MB. Útil para Unity / leituras grandes. Auto-compactação continua. Aplica na próxima mensagem.',
                        })}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </>
              }
            />
          </div>
          <ComposerToolbar
            hasInput={hasInput}
            autoSuggestText={debouncedInput}
            agent={props.agent}
            setAgent={props.setAgent}
            provider={props.provider}
            model={props.model}
            setModel={props.setModel}
            onSwitchProvider={props.onSwitchProvider}
            onSend={handleSend}
            onAbort={props.onAbort}
            streaming={streaming}
            handleFiles={handleFiles}
            providerOptions={props.providerOptions}
            currentProviderModels={props.currentProviderModels}
            maxTurns={props.maxTurns}
            setMaxTurns={props.setMaxTurns}
            temperature={props.temperature}
            setTemperature={props.setTemperature}
            unrestrictedOutput={props.unrestrictedOutput ?? false}
            setUnrestrictedOutput={props.setUnrestrictedOutput}
            fallbackProvider={props.fallbackProvider ?? null}
            fallbackModel={props.fallbackModel ?? null}
            onFallbackChange={props.onFallbackChange ?? (() => {})}
            getModelsForProvider={props.getModelsForProvider ?? (() => [])}
            sessionId={props.sessionId ?? null}
            selectedPipelineId={props.selectedPipelineId ?? null}
            setSelectedPipelineId={props.setSelectedPipelineId}
            thinking={props.thinking}
            setThinking={props.setThinking}
            supportsThinking={props.supportsThinking}
            deepThink={props.deepThink}
            setDeepThink={props.setDeepThink}
          />
        </div>
      </div>
    );
  },
);
