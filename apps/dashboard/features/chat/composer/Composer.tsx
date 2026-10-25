import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Paperclip, Sparkles, X } from 'lucide-react';
import { Textarea } from '../../../components/ui/textarea.js';
import { useConfirm } from '../../../components/ui/dialog-provider.js';
import { toast } from '../../../components/ui/prompt-dialog.js';
import type { AgentAttachment, EnrichedProviderModel, ExecutionMode, ProviderOption } from '../types.js';
import { filesToAttachments } from '../utils.js';
import { ComposerToolbar } from './ComposerToolbar.js';
import { ComposerActionIcons } from './ComposerActionIcons.js';
import { ModelSettingsDialog, modelSettingsLabel } from './ModelSettingsDialog.js';
import { RailComposerBar } from './RailComposerBar.js';
import { VoiceCaptureBar } from './VoiceCaptureBar.js';
import { MicButton } from './MicButton.js';
import { MicDevicePicker } from './MicDevicePicker.js';
import { useVoiceCaptureStatus, requestVoiceCaptureStop } from './voice-capture-store.js';
import type { OutputCapLevel } from './output-cap-levels.js';
import { useFileDrop } from './useFileDrop.js';
import { DropOverlay } from './DropOverlay.js';
import { useMarkdownShortcuts } from './useMarkdownShortcuts.js';
import { useComposerDraft } from './useComposerDraft.js';
import type { QueueMode } from './useMessageQueue.js';
import type { AgentPreset } from '@mcp/api-bus';
import { useSkillPicker } from './useSkillPicker.js';
import type { SkillSuggestion } from './skill-mention.js';
import { useSessionReferences, type SessionReference } from './useSessionReferences.js';
import { AgenticModeControl } from './AgenticModeControl.js';

type AgentId = AgentPreset;

// Visual cue: tints the composer's left border by the active mode so the
// user sees-at-a-glance which agent is loaded. The functional gates
// (confirm-before-irreversible, tier filtering) live in the runner.
const BORDER_TINT: Partial<Record<AgentId, string>> = {
  explore: 'border-l-sky-500',
  plan: 'border-l-violet-500',
  build: 'border-l-emerald-500',
  admin: 'border-l-rose-500',
  spec: 'border-l-amber-500',
  app_db: 'border-l-teal-500',
  api: 'border-l-cyan-500',
  diagram: 'border-l-violet-500',
  builder: 'border-l-fuchsia-500',
};

export interface ComposerHandle {
  setInput: (v: string) => void;
  /** Replace the composer's staged attachments — used by Rollback to restore
   *  the original message's image/document attachments alongside its text. */
  setAttachments: (a: AgentAttachment[]) => void;
}

interface ComposerProps {
  sessionCollaboration?: boolean;
  onSend: (text: string, attachments: AgentAttachment[], selectedSkillIds?: string[]) => void;
  onAbort: () => void;
  streaming: boolean;
  /**
   * Compact "Copilot" layout (editor rail): no markdown formatting toolbar,
   * pickers (agent/provider/model/max-turns/temperature/fallback) collapse
   * behind a settings dialog, the Think toggle is promoted to a labelled
   * pill, and the session action icons stay inline. Every function from the
   * full composer remains reachable — see `RailComposerBar`.
   */
  compact?: boolean;
  /** Project file paths chosen in the sidebar; injected into the prompt
   *  as a `<file_refs>` block on send and cleared via `onClearPicks`. */
  filePicks?: string[];
  onRemovePick?: (path: string) => void;
  onClearPicks?: () => void;
  /** Skill ids explicitly chosen for the message; forwarded to the server which prepends
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
  maxAutoContinues: number;
  setMaxAutoContinues: (v: number) => void;
  /** Per-session temperature override. `null` = inherit from role/agent/default. */
  temperature: number | null;
  setTemperature: (v: number | null) => void;
  /**
   * Per-session sticky reasoning-effort override (migration 150). `null` = use
   * the model default. Orthogonal to `thinking`. The selector is only rendered
   * when `reasoningLevels` is non-empty (model exposes discrete effort levels).
   */
  reasoningEffort?: string | null;
  setReasoningEffort?: (v: string | null) => void;
  /** Discrete effort levels the selected model supports. Empty → hide selector. */
  reasoningLevels?: string[];
  /** Product-level execution profile. Ultra is resolved locally per model. */
  executionMode?: ExecutionMode;
  setExecutionMode?: (v: ExecutionMode) => void;
  /** True while the execution-mode PATCH is being acknowledged. */
  executionModePending?: boolean;
  /** Ultra cannot change while a runner is active/suspended or a write is pending. */
  executionModeLocked?: boolean;
  /** Ultra owns the effective reasoning flag for the selected model. */
  ultraControlsThinking?: boolean;
  /** Keep composing possible, but gate every visible/keyboard send path. */
  sendBlocked?: boolean;
  /**
   * Per-session sticky plan-depth (migration 151): 'simple' | 'normal' |
   * 'complex'. `null` → 'normal'. The selector is rendered only when the
   * `plan` agent is active.
   */
  planDepth?: string | null;
  setPlanDepth?: (v: string | null) => void;
  /** Per-session response-language override (migration 177). NULL → auto. */
  responseLanguage?: string | null;
  setResponseLanguage?: (v: string | null) => void;
  /** Per-session output style (migration 178): proactive | explanatory | learning. */
  outputStyle?: string | null;
  setOutputStyle?: (v: string | null) => void;
  /**
   * Per-session "unrestricted tool output" toggle (migration 078). When true,
   * the runner / mcp-bridge / code_exec lift their per-tool-call truncation
   * caps to a high safety ceiling (≈1 MB). Useful for Unity / large file
   * reads. Auto-compaction still runs.
   */
  outputCapLevel?: OutputCapLevel;
  setOutputCapLevel?: (v: OutputCapLevel) => void;
  /**
   * Per-session tool permission mode (migration 131) — PermissionGate.
   * 'ask' pauses every write/execute/admin tool for approval, 'auto'
   * pauses execute/admin only, 'unrestricted' never pauses. Persisted via
   * PATCH (applies mid-run); rendered as a cycling shield toggle.
   */
  toolPermissionMode?: 'ask' | 'auto' | 'unrestricted';
  setToolPermissionMode?: (v: 'ask' | 'auto' | 'unrestricted') => void;
  sessionId?: string | null;
  /** Thinking mode toggle — only shown when provider supports it. */
  thinking?: boolean;
  setThinking?: (v: boolean) => void;
  supportsThinking?: boolean;
  /** "Describe images" — force the vision-fallback (image → text) even on
   *  vision-capable models. Auto-applies for blind models regardless. */
  describeImages?: boolean;
  setDescribeImages?: (v: boolean) => void;
  /** Session rule: generated code should contain no newly added comments. */
  blockCodeComments?: boolean;
  setBlockCodeComments?: (v: boolean) => void;
  /** Fallback configuration. */
  fallbackProvider?: string | null;
  fallbackModel?: string | null;
  onFallbackChange?: (provider: string | null, model: string | null) => void;
  getModelsForProvider?: (providerId: string) => EnrichedProviderModel[];
  /** Hide the agent picker (guided surfaces like App Studio lock the agent). */
  hideAgentPicker?: boolean;
  /**
   * Message-queue wiring. When `queueable`, the composer stays usable while the
   * agent streams: composing + the split button enqueue a follow-up via
   * `onQueue` (next-turn → injected into the live run; end-of-session → parked).
   * `queuedStrip` is the rendered queue list, shown above the input.
   */
  queueable?: boolean;
  onQueue?: (
    text: string,
    mode: QueueMode,
    attachments: AgentAttachment[],
    skillIds?: string[],
  ) => void;
  queuedStrip?: React.ReactNode;
}

// React.memo wraps the forwardRef so AgentChat's per-click / per-stream-frame
// re-renders don't cascade into this heavy subtree. The memo only holds if
// EVERY prop is referentially stable across those renders — AgentChat now
// useCallback-wraps all handler props and useMemo's the two inline-computed
// props (reasoningLevels, queuedStrip); providerOptions/currentProviderModels/
// getModelsForProvider are memoized at their source in useAgentChatState.
const ComposerImpl = React.forwardRef<ComposerHandle, ComposerProps>(
  function Composer(props, ref) {
    const { t } = useTranslation('chat');
    const { streaming } = props;
    const [input, setInput] = useState('');
    const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
    // Per-session draft persistence: keep the in-progress text + attachments
    // alive across navigation (this component unmounts on route change). Keyed
    // in the `coder:` namespace — company sessions use `company:` to avoid id
    // collisions. `clearDraft` is called synchronously at every send site.
    const draftKey = props.sessionId != null ? `coder:${props.sessionId}` : null;
    const { clearDraft } = useComposerDraft({ draftKey, input, setInput, attachments, setAttachments });
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    // Model settings (provider / model / turns / temperature / reasoning /
    // fallback) collapse behind a dialog opened from the provider·model chip
    // in the action-icons strip — keeps the bottom toolbar row calm.
    const [modelDialogOpen, setModelDialogOpen] = useState(false);
    // Keep only the smart keyboard behaviors (Tab indent + Enter list
    // continuation) — the visual markdown formatting toolbar was removed
    // (useless markers for an AI-prompt composer).
    const { handleKeyDown: mdKeyDown } = useMarkdownShortcuts(textareaRef, input, setInput);
    const confirm = useConfirm();

    // Debounced value for AgentPicker auto-suggest (avoids re-rendering toolbar on every keystroke)
    const [debouncedInput, setDebouncedInput] = useState('');
    useEffect(() => {
      const h = setTimeout(() => setDebouncedInput(input), 300);
      return () => clearTimeout(h);
    }, [input]);

    const picker = useSkillPicker(input, props.sessionId);
    const references = useSessionReferences(props.sessionCollaboration ? props.sessionId : undefined, input, picker.caret);
    const selectReference = (item: SessionReference) => {
      if (!references.mention) return;
      const { start, end, trigger } = references.mention;
      const replacement = `${trigger}${item.label} `;
      references.choose(item);
      setInput(input.slice(0, start) + replacement + input.slice(end));
      picker.setCaret(start + replacement.length);
      requestAnimationFrame(() => { textareaRef.current?.focus(); textareaRef.current?.setSelectionRange(start + replacement.length, start + replacement.length); });
    };
    const pendingSkill = useRef(false);
    const currentDraft = useRef({ input, attachments, sessionId: props.sessionId });
    currentDraft.current = { input, attachments, sessionId: props.sessionId };
    const resolveTypedSkill = useCallback(async (command: string) => {
      if (pendingSkill.current) return undefined;
      pendingSkill.current = true;
      const snapshot = currentDraft.current;
      try {
        const skill = await picker.resolveSlash(command);
        const current = currentDraft.current;
        return current.input === snapshot.input && current.attachments === snapshot.attachments && current.sessionId === snapshot.sessionId ? skill : undefined;
      } catch {
        toast.error(t('composer.skillsError'));
        return undefined;
      } finally { pendingSkill.current = false; }
    }, [picker.resolveSlash, t]);
    const selectSkill = (skill: SkillSuggestion) => {
      if (!picker.mention) return;
      const { start, end, trigger } = picker.mention;
      const replacement = trigger === '/' ? '/' + skill.command + ' ' : '';
      picker.setPicks(current => current.some(item => item.id === skill.id) ? current : [...current, skill]);
      setInput(input.slice(0, start) + replacement + input.slice(end));
      const nextCaret = start + replacement.length;
      picker.setCaret(nextCaret);
      requestAnimationFrame(() => { textareaRef.current?.focus(); textareaRef.current?.setSelectionRange(nextCaret, nextCaret); });
    };

    useImperativeHandle(ref, () => ({ setInput, setAttachments }), []);

    // Voice dictation: append the transcript to whatever is already typed.
    // Functional updater (memoised []) — transcription resolves async.
    const appendTranscript = useCallback((text: string) => {
      setInput((prev) => (prev ? `${prev.trimEnd()} ${text}` : text));
    }, []);
    const voiceRecording = useVoiceCaptureStatus() === 'recording';

    const handleFiles = useCallback(async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      try {
        const arr = await filesToAttachments(files, attachments, {
          // Desktop coder sessions can authorize an exact local file and let
          // the agent read it lazily. Browser/company surfaces retain the
          // portable inline path because they have no host filesystem grant.
          preferFileReferences: props.sessionId != null,
        });
        setAttachments((prev) => [...prev, ...arr]);
      } catch (error) {
        toast.error(t('composer.attachmentRejected', { defaultValue: 'Attachment rejected' }), {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    }, [attachments, props.sessionId, t]);

    const { isDragging, dropHandlers } = useFileDrop({
      onFiles: handleFiles,
      disabled: streaming && !props.queueable,
    });

    // Auto-resize textarea based on content
    useEffect(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.style.height = 'auto';
      const minH = 40;  // ~1.5 rows — grows as the user types
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

    const hasInput = input.trim().length > 0 || attachments.length > 0 || picker.picks.length > 0 || !!props.skillPicks?.length;

    const handleSend = useCallback(async () => {
      if (props.sendBlocked || (!input.trim() && attachments.length === 0 && picker.picks.length === 0 && !props.skillPicks?.length)) return;

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

      const text = input.trim()
        ? input
        : attachments.length ? t('composer.analyzeAttachments', { defaultValue: 'Analyze the attached files.' }) : t('composer.useSkills');
      const picks = props.filePicks ?? [];
      const skillIds = [...new Set([...(props.skillPicks ?? []), ...picker.picks.map(item => item.id)])];
      if (!await references.commit()) return;

      // Intercept slash commands: /command args → attach the skill instead of
      // inlining its expanded prompt. The typed `/command args` stays visible
      // as the user message; the skill body is injected as <active_skills> by
      // the runner each turn (same path as a manual skill pick).
      if (text.startsWith('/') && props.sessionId) {
        const spaceIdx = text.indexOf(' ');
        const cmd = spaceIdx > 0 ? text.slice(1, spaceIdx) : text.slice(1);
        const match = await resolveTypedSkill(cmd);
        if (match === undefined) return;
        if (match) {
          setInput('');
          setAttachments([]);
          clearDraft();
          picker.clear();
          references.clear();
          props.onClearPicks?.();
          props.onClearSkillPicks?.();
          const merged = [match.id, ...skillIds.filter((s) => s !== match.id)];
          props.onSend(text, attachments, merged);
          return;
        }
      }

      const finalText = picks.length > 0
        ? `<file_refs>\n${picks.map((p) => `- ${p}`).join('\n')}\n</file_refs>\n\n${text}`
        : text;
      const atts = attachments;
      setInput('');
      setAttachments([]);
      clearDraft();
      picker.clear();
      references.clear();
      props.onClearPicks?.();
      props.onClearSkillPicks?.();
      props.onSend(finalText, atts, skillIds.length > 0 ? skillIds : undefined);
    }, [input, attachments, picker.picks, resolveTypedSkill, references.commit, props.agent, props.onSend, props.sessionId, props.filePicks, props.onClearPicks, props.skillPicks, props.onClearSkillPicks, props.sendBlocked, confirm, clearDraft, t]);

    // Enqueue the composed message while the agent is streaming. Same
    // file_refs prefixing + clears as `handleSend`, but the delivery timing
    // (next turn vs end of session) is decided by the queue. Attachments travel
    // with the queued item so they cannot bleed into a later immediate send.
    const handleQueue = useCallback(async (mode: QueueMode) => {
      if ((!input.trim() && attachments.length === 0 && picker.picks.length === 0 && !props.skillPicks?.length) || !props.onQueue) return;
      const text = input.trim()
        ? input
        : attachments.length ? t('composer.analyzeAttachments', { defaultValue: 'Analyze the attached files.' }) : t('composer.useSkills');
      const picks = props.filePicks ?? [];
      const skillIds = [...new Set([...(props.skillPicks ?? []), ...picker.picks.map(item => item.id)])];
      const atts = attachments;
      if (!await references.commit()) return;
      // Slash command: same interception as handleSend — the typed `/cmd`
      // stays as the message, the matched skill rides as a pick (no file_refs
      // prefix), so a queued slash command behaves like a sent one.
      if (text.startsWith('/') && props.sessionId) {
        const spaceIdx = text.indexOf(' ');
        const cmd = spaceIdx > 0 ? text.slice(1, spaceIdx) : text.slice(1);
        const match = await resolveTypedSkill(cmd);
        if (match === undefined) return;
        if (match) {
          setInput('');
          setAttachments([]);
          clearDraft();
          picker.clear();
          references.clear();
          props.onClearPicks?.();
          props.onClearSkillPicks?.();
          const merged = [match.id, ...skillIds.filter((s) => s !== match.id)];
          props.onQueue(text, mode, atts, merged);
          return;
        }
      }
      const finalText = picks.length > 0
        ? `<file_refs>\n${picks.map((p) => `- ${p}`).join('\n')}\n</file_refs>\n\n${text}`
        : text;
      setInput('');
      setAttachments([]);
      clearDraft();
      picker.clear();
      references.clear();
      props.onClearPicks?.();
      props.onClearSkillPicks?.();
      props.onQueue(finalText, mode, atts, skillIds.length > 0 ? skillIds : undefined);
    }, [input, attachments, picker.picks, resolveTypedSkill, references.commit, props.sessionId, props.filePicks, props.skillPicks, props.onClearPicks, props.onClearSkillPicks, props.onQueue, clearDraft, t]);

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

    const skillPicks = [...new Set([...(props.skillPicks ?? []), ...picker.picks.map(item => item.id)])];

    return (
      <div className="relative border-t border-[var(--workbench-border)] bg-[var(--workbench-raised)]" {...dropHandlers}>
        <DropOverlay show={isDragging} />
        {props.queuedStrip}
        {props.sessionCollaboration && props.sessionId && <div className="flex items-center justify-between border-b px-2 py-1">
          <AgenticModeControl sessionId={props.sessionId} /><span className="text-[10px] text-muted-foreground"># skills · @ chats · $ projetos</span>
        </div>}
        {references.error && <p role="alert" className="p-2 text-xs text-destructive">{references.error}</p>}
        {references.picks.length > 0 && <div className="flex flex-wrap gap-1 p-2">{references.picks.map(item => <span key={`${item.kind}:${item.id}`} className="inline-flex items-center gap-1 rounded border bg-muted px-2 text-xs">
          {item.kind === 'chat' ? '@' : '$'}{item.label}<button type="button" aria-label={t('network.removeReference', { name: item.label })} onClick={() => references.remove(item)}><X className="h-3 w-3" /></button>
        </span>)}</div>}
        {(attachments.length > 0 || filePicks.length > 0 || skillPicks.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 mb-3">
            {skillPicks.map((id) => (
              <div
                key={`skill-${id}`}
                className="group inline-flex items-center gap-1 h-6 pl-1.5 pr-1 rounded-md border border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400 text-[11px] max-w-[180px]"
                title={id}
              >
                <Sparkles className="h-3 w-3 shrink-0" />
                <span className="truncate">{picker.picks.find(item => item.id === id)?.name ?? id}</span>
                <button
                  type="button"
                  onClick={() => { picker.setPicks(current => current.filter(item => item.id !== id)); if (props.skillPicks?.includes(id)) props.onRemoveSkillPick?.(id); }}
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

        <div className={`relative border-l-2 ${BORDER_TINT[props.agent] ?? ''} bg-background focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring transition`}>
          {voiceRecording && <VoiceCaptureBar onStop={requestVoiceCaptureStop} />}
          {references.open && <div role="listbox" aria-label={t(references.mention?.trigger === '$' ? 'network.projects' : 'network.chats')} className="absolute bottom-full left-0 right-0 z-50 mb-1 max-h-56 overflow-auto rounded-lg border bg-popover text-popover-foreground shadow-md">
            {references.loading && <p className="p-3 text-xs">{t('drive.loading')}</p>}
            {!references.loading && references.items.length === 0 && <p className="p-3 text-xs text-muted-foreground">{t('network.noSuggestions')}</p>}
            {references.items.map((item, index) => <button key={`${item.kind}:${item.id}`} type="button" role="option" aria-selected={index === references.index}
              className={`block w-full px-3 py-2 text-left text-xs hover:bg-muted ${index === references.index ? 'bg-muted' : ''}`}
              onMouseDown={event => { event.preventDefault(); selectReference(item); }}>
              <span className="block font-medium">{item.kind === 'chat' ? '@' : '$'}{item.label}</span><span className="block truncate text-muted-foreground">{item.detail}</span>
            </button>)}
          </div>}
          {picker.open && (
            <div role="listbox" aria-label={t('composer.skills')} className="absolute bottom-full left-0 right-0 mb-1 z-50 rounded-lg border bg-popover text-popover-foreground shadow-md max-h-56 overflow-auto">
              {picker.loading && <p className="p-3 text-xs text-muted-foreground">{t('composer.skillsLoading')}</p>}
              {!picker.loading && picker.visible.length === 0 && <p className="p-3 text-xs text-muted-foreground">{t(picker.error ? 'composer.skillsError' : 'composer.skillsEmpty')}</p>}
              {picker.visible.map((skill, index) => (
                <button key={skill.id} type="button" role="option" aria-selected={index === picker.index}
                  className={'flex items-start gap-2 w-full px-3 py-2 text-left text-sm hover:bg-muted ' + (index === picker.index ? 'bg-muted' : '')}
                  onMouseDown={event => { event.preventDefault(); selectSkill(skill); }}>
                  <Sparkles className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
                  <span className="min-w-0"><span className="block truncate text-xs font-medium">{picker.mention?.trigger}{picker.mention?.trigger === '/' ? skill.command : skill.name}</span>
                    <span className="block text-xs text-muted-foreground line-clamp-2">{skill.description}</span></span>
                </button>
              ))}
            </div>
          )}
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => { setInput(e.target.value); picker.setCaret(e.target.selectionStart); }}
            onSelect={(e) => picker.setCaret(e.currentTarget.selectionStart)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (references.open) {
                if (e.key === 'Escape') { e.preventDefault(); references.dismiss(); return; }
                if (references.items.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                  e.preventDefault(); references.setIndex(index => Math.max(0, Math.min(references.items.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))); return;
                }
                if (references.items.length && (e.key === 'Tab' || (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey))) {
                  e.preventDefault(); selectReference(references.items[references.index]!); return;
                }
              }
              if (picker.open) {
                if (e.key === 'Escape') { e.preventDefault(); picker.dismiss(); return; }
                if (picker.visible.length > 0) {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    picker.setIndex(index => Math.max(0, Math.min(picker.visible.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1))));
                    return;
                  }
                  if (e.key === 'Tab' || (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey)) {
                    e.preventDefault(); const skill = picker.visible[picker.index]; if (skill) selectSkill(skill); return;
                  }
                }
              }
              // Highest priority: send message — or enqueue while streaming.
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (streaming) {
                  if (props.queueable && hasInput) handleQueue('next-turn');
                } else if (!props.sendBlocked) {
                  handleSend();
                }
                return;
              }
              // Markdown shortcuts and smart behaviors
              mdKeyDown(e);
            }}
            placeholder={t('composer.placeholder')}
            rows={1}
            disabled={streaming && !props.queueable}
            className="border-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 bg-transparent text-sm min-h-0 py-1.5"
          />
          {props.compact ? (
            <RailComposerBar
              hasInput={hasInput}
              autoSuggestText={debouncedInput}
              agent={props.agent}
              setAgent={props.setAgent}
              hideAgentPicker={props.hideAgentPicker}
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
              maxAutoContinues={props.maxAutoContinues}
              setMaxAutoContinues={props.setMaxAutoContinues}
              temperature={props.temperature}
              setTemperature={props.setTemperature}
              reasoningEffort={props.reasoningEffort ?? null}
              setReasoningEffort={props.setReasoningEffort}
              reasoningLevels={props.reasoningLevels ?? []}
              executionMode={props.executionMode ?? 'standard'}
              setExecutionMode={props.setExecutionMode}
              executionModePending={props.executionModePending}
              executionModeLocked={props.executionModeLocked}
              planDepth={props.planDepth ?? null}
              setPlanDepth={props.setPlanDepth}
              outputCapLevel={props.outputCapLevel ?? 'economic'}
              setOutputCapLevel={props.setOutputCapLevel}
              fallbackProvider={props.fallbackProvider ?? null}
              fallbackModel={props.fallbackModel ?? null}
              onFallbackChange={props.onFallbackChange ?? (() => {})}
              getModelsForProvider={props.getModelsForProvider ?? (() => [])}
              sessionId={props.sessionId ?? null}
              thinking={props.thinking}
              setThinking={props.setThinking}
              supportsThinking={props.supportsThinking}
              ultraControlsThinking={props.ultraControlsThinking}
              describeImages={props.describeImages}
              setDescribeImages={props.setDescribeImages}
              blockCodeComments={props.blockCodeComments}
              setBlockCodeComments={props.setBlockCodeComments}
              toolPermissionMode={props.toolPermissionMode}
              setToolPermissionMode={props.setToolPermissionMode}
              queueable={!!props.queueable}
              sendBlocked={props.sendBlocked}
              onQueueSend={handleQueue}
              onTranscript={appendTranscript}
            />
          ) : (
          <>
          {/*
            Thin strip for the "session-level" action icons (attachment /
            think / describe / cap / permission shield). The
            markdown formatting toolbar that used to host these was removed —
            its markers are useless in an AI-prompt composer. Keeping this row
            above the busier bottom row leaves the pickers (agent / provider /
            model) and Send button focused.
          */}
          <div className="flex items-center justify-start gap-0.5 px-2 py-0.5 border-t border-dashed border-border/40">
            <ComposerActionIcons
              streaming={streaming}
              allowAttachmentsWhileStreaming={!!props.queueable}
              handleFiles={handleFiles}
              thinking={props.thinking}
              setThinking={props.supportsThinking || props.ultraControlsThinking
                ? props.setThinking
                : undefined}
              thinkingManaged={props.ultraControlsThinking}
              describeImages={props.describeImages}
              setDescribeImages={props.setDescribeImages}
              blockCodeComments={props.blockCodeComments}
              setBlockCodeComments={props.setBlockCodeComments}
              outputCapLevel={props.outputCapLevel ?? 'economic'}
              setOutputCapLevel={props.setOutputCapLevel}
              toolPermissionMode={props.toolPermissionMode}
              setToolPermissionMode={props.setToolPermissionMode}
              sessionId={props.sessionId}
              onTranscript={appendTranscript}
              showMic={false}
            />
            {/* provider · model chip — opens the model settings dialog. */}
            <button
              type="button"
              onClick={() => setModelDialogOpen(true)}
              className="ml-auto inline-flex items-center max-w-[55%] h-7 px-2 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title={t('toolbar.modelSettings', { defaultValue: 'Model settings' })}
            >
              <span className="truncate font-mono">
                {modelSettingsLabel(
                  props.providerOptions,
                  props.provider,
                  props.model,
                  t('composer.selectModel', { defaultValue: 'Select a model' }),
                )}
              </span>
              {props.executionMode === 'ultra' && (
                <span className="ml-1.5 shrink-0 font-medium text-violet-600 dark:text-violet-300">
                  {t('ultra.badge', { defaultValue: 'Ultra' })}
                </span>
              )}
            </button>
            {/* Mic + device picker live AFTER the model name. */}
            <MicButton onTranscript={appendTranscript} disabled={streaming} />
            <MicDevicePicker disabled={streaming} />
          </div>
          <ComposerToolbar
            hasInput={hasInput}
            autoSuggestText={debouncedInput}
            agent={props.agent}
            setAgent={props.setAgent}
            hideAgentPicker={props.hideAgentPicker}
            onSend={handleSend}
            onAbort={props.onAbort}
            streaming={streaming}
            reasoningEffort={props.reasoningEffort ?? null}
            setReasoningEffort={props.setReasoningEffort}
            reasoningLevels={props.reasoningLevels ?? []}
            executionMode={props.executionMode ?? 'standard'}
            sendBlocked={props.sendBlocked}
            planDepth={props.planDepth ?? null}
            setPlanDepth={props.setPlanDepth}
            queueable={!!props.queueable}
            onQueueSend={handleQueue}
          />
          <ModelSettingsDialog
            open={modelDialogOpen}
            onOpenChange={setModelDialogOpen}
            showAgent={false}
            agent={props.agent}
            setAgent={props.setAgent}
            autoSuggestText={debouncedInput}
            provider={props.provider}
            model={props.model}
            setModel={props.setModel}
            onSwitchProvider={props.onSwitchProvider}
            providerOptions={props.providerOptions}
            currentProviderModels={props.currentProviderModels}
            maxTurns={props.maxTurns}
            setMaxTurns={props.setMaxTurns}
            maxAutoContinues={props.maxAutoContinues}
            setMaxAutoContinues={props.setMaxAutoContinues}
            temperature={props.temperature}
            setTemperature={props.setTemperature}
            reasoningEffort={props.reasoningEffort ?? null}
            setReasoningEffort={props.setReasoningEffort}
            reasoningLevels={props.reasoningLevels ?? []}
            executionMode={props.executionMode ?? 'standard'}
            setExecutionMode={props.setExecutionMode}
            executionModePending={props.executionModePending}
            executionModeLocked={props.executionModeLocked}
            planDepth={props.planDepth ?? null}
            setPlanDepth={props.setPlanDepth}
            responseLanguage={props.responseLanguage ?? null}
            setResponseLanguage={props.setResponseLanguage}
            outputStyle={props.outputStyle ?? null}
            setOutputStyle={props.setOutputStyle}
            fallbackProvider={props.fallbackProvider ?? null}
            fallbackModel={props.fallbackModel ?? null}
            onFallbackChange={props.onFallbackChange ?? (() => {})}
            getModelsForProvider={props.getModelsForProvider ?? (() => [])}
          />
          </>
          )}
        </div>
      </div>
    );
  },
);

export const Composer = React.memo(ComposerImpl);
