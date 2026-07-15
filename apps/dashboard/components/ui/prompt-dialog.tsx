/**
 * Promise-based prompt / confirm dialogs that work inside Electron.
 *
 * Electron blocks `window.prompt`, `window.alert`, and `window.confirm`
 * when contextIsolation is on — the renderer throws "prompt() is not
 * supported." The substitute is a small global store + a portaled
 * Radix Dialog that renders the currently-open request and resolves a
 * Promise when the user picks an answer.
 *
 * Usage:
 *
 *   const name = await prompt({
 *     title: 'New file',
 *     placeholder: 'name.ts',
 *     defaultValue: 'untitled.ts',
 *     confirmLabel: 'Create',
 *   });
 *   if (!name) return; // user cancelled
 *
 *   if (await confirm({ title: 'Delete file?', tone: 'destructive' })) { … }
 *
 *   toast.success('Saved');
 *   toast.error('Save failed', { description: err.message });
 *
 * Mount the host once near the React root (App.tsx renders
 * <PromptDialogHost /> and <ToastHost />).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  CheckCircle2,
  Info,
  X as XIcon,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog.js';
import { Button } from './button.js';
import { Input } from './input.js';
import { cn } from '../../lib/utils.js';

// ─── Prompt store ────────────────────────────────────────────

export interface PromptOptions {
  title: string;
  description?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Optional regex/validator — return error message or null. */
  validate?: (value: string) => string | null;
  /** Append a `.ext` to the suggestion as a quick chip. */
  extensionHint?: string;
}

interface PromptRequest {
  id: number;
  opts: PromptOptions;
  resolve: (value: string | null) => void;
}

interface PromptState {
  active: PromptRequest | null;
  open: (opts: PromptOptions) => Promise<string | null>;
  resolve: (value: string | null) => void;
}

let promptCounter = 0;

const usePromptStore = create<PromptState>((set, get) => ({
  active: null,
  open: (opts) =>
    new Promise<string | null>((resolve) => {
      promptCounter += 1;
      set({ active: { id: promptCounter, opts, resolve } });
    }),
  resolve: (value) => {
    const cur = get().active;
    if (!cur) return;
    cur.resolve(value);
    set({ active: null });
  },
}));

export function prompt(opts: PromptOptions): Promise<string | null> {
  return usePromptStore.getState().open(opts);
}

// ─── Confirm store ───────────────────────────────────────────

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'destructive';
}

interface ConfirmRequest {
  id: number;
  opts: ConfirmOptions;
  resolve: (value: boolean) => void;
}

interface ConfirmState {
  active: ConfirmRequest | null;
  open: (opts: ConfirmOptions) => Promise<boolean>;
  resolve: (value: boolean) => void;
}

let confirmCounter = 0;

const useConfirmStore = create<ConfirmState>((set, get) => ({
  active: null,
  open: (opts) =>
    new Promise<boolean>((resolve) => {
      confirmCounter += 1;
      set({ active: { id: confirmCounter, opts, resolve } });
    }),
  resolve: (value) => {
    const cur = get().active;
    if (!cur) return;
    cur.resolve(value);
    set({ active: null });
  },
}));

export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return useConfirmStore.getState().open(opts);
}

// ─── Toast store ─────────────────────────────────────────────

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
  /** ms before auto-dismiss; defaults vary by kind (success short, error long). */
  duration?: number;
}

interface ToastState {
  items: Toast[];
  push: (t: Omit<Toast, 'id'>) => number;
  dismiss: (id: number) => void;
}

let toastCounter = 0;

const useToastStore = create<ToastState>((set) => ({
  items: [],
  push: (input) => {
    toastCounter += 1;
    const id = toastCounter;
    const t: Toast = { id, ...input };
    set((s) => ({ items: [...s.items, t] }));
    return id;
  },
  dismiss: (id) =>
    set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
}));

interface PushShape {
  description?: string;
  duration?: number;
}

export const toast = {
  success(title: string, opts: PushShape = {}): void {
    useToastStore.getState().push({ kind: 'success', title, duration: 3000, ...opts });
  },
  error(title: string, opts: PushShape = {}): void {
    useToastStore.getState().push({ kind: 'error', title, duration: 6500, ...opts });
  },
  info(title: string, opts: PushShape = {}): void {
    useToastStore.getState().push({ kind: 'info', title, duration: 4000, ...opts });
  },
  warning(title: string, opts: PushShape = {}): void {
    useToastStore.getState().push({ kind: 'warning', title, duration: 5000, ...opts });
  },
};

// ─── Host components ─────────────────────────────────────────

export function PromptDialogHost() {
  const active = usePromptStore((s) => s.active);
  const resolve = usePromptStore((s) => s.resolve);
  if (!active) return null;
  return <PromptDialogBody key={active.id} request={active} onResolve={resolve} />;
}

function PromptDialogBody({
  request,
  onResolve,
}: {
  request: PromptRequest;
  onResolve: (value: string | null) => void;
}) {
  const { t } = useTranslation('common');
  const { opts } = request;
  const [value, setValue] = useState(opts.defaultValue ?? '');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      // Select the basename without extension by default — matches the
      // inline rename UX so the user can rename "foo" without losing
      // ".ts".
      const dot = (opts.defaultValue ?? '').lastIndexOf('.');
      if (dot > 0) {
        el.setSelectionRange(0, dot);
      } else {
        el.select();
      }
    });
    return () => cancelAnimationFrame(id);
  }, [opts.defaultValue]);

  const submit = useCallback(() => {
    if (opts.validate) {
      const v = opts.validate(value);
      if (v) {
        setError(v);
        return;
      }
    }
    onResolve(value);
  }, [opts, value, onResolve]);

  return (
    <Dialog open onOpenChange={(o) => !o && onResolve(null)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[14px]">{opts.title}</DialogTitle>
          {opts.description && (
            <DialogDescription className="text-[12px]">{opts.description}</DialogDescription>
          )}
        </DialogHeader>
        <div className="space-y-2">
          <Input
            ref={inputRef}
            value={value}
            placeholder={opts.placeholder}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
            className="h-8 text-[13px]"
          />
          {error && <p className="text-[11px] text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onResolve(null)}>
            {opts.cancelLabel ?? t('actions.cancel')}
          </Button>
          <Button onClick={submit} disabled={!value.trim()}>
            {opts.confirmLabel ?? t('actions.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmDialogHost() {
  const { t } = useTranslation('common');
  const active = useConfirmStore((s) => s.active);
  const resolve = useConfirmStore((s) => s.resolve);
  if (!active) return null;
  const { opts } = active;
  const destructive = opts.tone === 'destructive';
  const Icon = destructive ? AlertCircle : Info;
  return (
    <Dialog open onOpenChange={(o) => !o && resolve(false)}>
      <DialogContent className="max-w-md">
        <div className="flex items-start gap-3">
          <div className={cn(
            'mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full border',
            destructive
              ? 'border-destructive/25 bg-destructive/10 text-destructive'
              : 'border-primary/20 bg-primary/10 text-primary',
          )}>
            <Icon className="h-4 w-4" aria-hidden="true" />
          </div>
          <DialogHeader className="min-w-0 flex-1 pt-0.5 text-left">
            <DialogTitle className={cn('text-[14px]', destructive && 'text-destructive')}>
              {opts.title}
            </DialogTitle>
            {opts.description && (
              <DialogDescription className="whitespace-pre-line text-[12px] leading-relaxed">
                {opts.description}
              </DialogDescription>
            )}
          </DialogHeader>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => resolve(false)} autoFocus>
            {opts.cancelLabel ?? t('actions.cancel')}
          </Button>
          <Button
            className={cn(destructive && 'bg-destructive text-destructive-foreground hover:bg-destructive/90')}
            onClick={() => resolve(true)}
          >
            {opts.confirmLabel ?? t('actions.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ToastHost() {
  const items = useToastStore((s) => s.items);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <div
      className="fixed bottom-3 right-3 z-[200] flex flex-col-reverse gap-2 max-w-[360px] pointer-events-none"
      aria-live="polite"
    >
      {items.map((t) => (
        <ToastView key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastView({ toast: t, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const { t: translate } = useTranslation('common');

  useEffect(() => {
    if (!t.duration) return;
    const id = setTimeout(onDismiss, t.duration);
    return () => clearTimeout(id);
  }, [t.duration, onDismiss]);

  const Icon = useMemo(() => {
    switch (t.kind) {
      case 'success': return CheckCircle2;
      case 'error': return AlertCircle;
      case 'warning': return AlertCircle;
      case 'info': return Info;
    }
  }, [t.kind]);

  const iconColor = {
    success: 'text-emerald-500',
    error: 'text-destructive',
    warning: 'text-amber-500',
    info: 'text-primary',
  }[t.kind];

  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto rounded-md border bg-popover text-popover-foreground shadow-xl shadow-black/40',
        'flex items-start gap-2.5 px-3 py-2.5 text-[12px]',
        'animate-in slide-in-from-right-2 fade-in-50',
      )}
    >
      <Icon className={cn('h-3.5 w-3.5 shrink-0 mt-0.5', iconColor)} />
      <div className="flex-1 min-w-0">
        <p className="font-medium text-foreground truncate">{t.title}</p>
        {t.description && (
          <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-3 break-words">
            {t.description}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="text-muted-foreground hover:text-foreground h-4 w-4 grid place-items-center rounded-sm hover:bg-muted shrink-0"
        aria-label={translate('toast.dismiss')}
      >
        <XIcon className="h-3 w-3" />
      </button>
    </div>
  );
}
