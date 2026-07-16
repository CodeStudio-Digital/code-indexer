/** Promise-based confirm dialog for the portal.
 *
 *  Native `window.confirm` renders a browser-chrome popup that reads
 *  "account.codestudio.xyz says…" — an identity leak that also blocks the
 *  event loop. This is the self-contained replacement: a module-level store
 *  + a portaled panel that resolves a Promise when the user answers.
 *
 *  Usage:
 *    if (await confirm({ title: 'Delete?', tone: 'destructive' })) { … }
 *
 *  Mount <ConfirmHost /> once near the root (main.tsx). */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { Button, cn } from './ui.js';

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

// ─── Module-level store (no zustand — one live request at a time) ────
let current: ConfirmRequest | null = null;
let counter = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}
function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
function getSnapshot(): ConfirmRequest | null {
  return current;
}

/** Open a confirm dialog; resolves true on confirm, false on cancel/dismiss. */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    counter += 1;
    current = { id: counter, opts, resolve };
    emit();
  });
}

function settle(value: boolean): void {
  const req = current;
  current = null;
  emit();
  req?.resolve(value);
}

// ─── Host ───────────────────────────────────────────────────────────
export function ConfirmHost(): React.ReactElement | null {
  const active = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!active) return null;
  return <ConfirmBody key={active.id} request={active} />;
}

function ConfirmBody({ request }: { request: ConfirmRequest }): React.ReactElement {
  const { opts } = request;
  const destructive = opts.tone === 'destructive';
  const Icon = destructive ? AlertTriangle : Info;
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Focus Cancel first — a safe default for the destructive actions this
    // guards, and keeps focus inside the dialog.
    const id = requestAnimationFrame(() => cancelRef.current?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        settle(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        settle(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div
      className="portal-fade-in fixed inset-0 z-[100] grid place-items-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) settle(false);
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className="portal-pop-in w-full max-w-md rounded-xl border bg-card p-5 text-card-foreground shadow-xl"
      >
        <div className="flex items-start gap-3">
          <div
            className={cn(
              'mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full border',
              destructive
                ? 'border-destructive/25 bg-destructive/10 text-destructive'
                : 'border-primary/20 bg-primary/10 text-primary',
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            <h2
              id="confirm-title"
              className={cn('text-sm font-semibold', destructive && 'text-destructive')}
            >
              {opts.title}
            </h2>
            {opts.description ? (
              <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
                {opts.description}
              </p>
            ) : null}
          </div>
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          <Button ref={cancelRef} variant="ghost" size="sm" onClick={() => settle(false)}>
            {opts.cancelLabel ?? 'Cancel'}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'primary'}
            size="sm"
            onClick={() => settle(true)}
          >
            {opts.confirmLabel ?? 'Confirm'}
          </Button>
        </div>
      </div>
    </div>
  );
}
