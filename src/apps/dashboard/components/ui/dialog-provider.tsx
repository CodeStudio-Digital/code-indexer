import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { Button } from './button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog.js';
import { cn } from '../../lib/utils.js';

export type DialogVariant = 'info' | 'success' | 'warning' | 'destructive';

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: DialogVariant;
}

export interface NotifyOptions {
  title: string;
  description?: string;
  variant?: DialogVariant;
  okLabel?: string;
}

interface DialogState {
  kind: 'confirm' | 'notify';
  options: ConfirmOptions | NotifyOptions;
  resolve: (value: boolean) => void;
}

interface DialogContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  notify: (options: NotifyOptions) => Promise<void>;
}

const DialogContext = createContext<DialogContextValue | null>(null);

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<DialogState | null>(null);
  const stateRef = useRef<DialogState | null>(null);
  stateRef.current = state;

  const close = useCallback((result: boolean) => {
    const cur = stateRef.current;
    if (!cur) return;
    cur.resolve(result);
    setState(null);
  }, []);

  const confirm = useCallback<DialogContextValue['confirm']>(
    (options) =>
      new Promise<boolean>((resolve) => {
        setState({ kind: 'confirm', options, resolve });
      }),
    [],
  );

  const notify = useCallback<DialogContextValue['notify']>(
    (options) =>
      new Promise<void>((resolve) => {
        setState({ kind: 'notify', options, resolve: () => resolve() });
      }),
    [],
  );

  const value = useMemo(() => ({ confirm, notify }), [confirm, notify]);

  return (
    <DialogContext.Provider value={value}>
      {children}
      <DialogHost state={state} onClose={close} />
    </DialogContext.Provider>
  );
}

export function useConfirm(): DialogContextValue['confirm'] {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useConfirm must be used inside <DialogProvider>');
  return ctx.confirm;
}

export function useNotify(): DialogContextValue['notify'] {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useNotify must be used inside <DialogProvider>');
  return ctx.notify;
}

const VARIANT_ICON: Record<DialogVariant, React.ElementType> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  destructive: XCircle,
};

const VARIANT_STYLES: Record<DialogVariant, string> = {
  info: 'bg-info/15 text-info',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  destructive: 'bg-destructive/15 text-destructive',
};

interface DialogHostProps {
  state: DialogState | null;
  onClose: (result: boolean) => void;
}

function DialogHost({ state, onClose }: DialogHostProps) {
  const open = state !== null;
  const variant = state?.options.variant ?? (state?.kind === 'confirm' ? 'warning' : 'info');
  const Icon = VARIANT_ICON[variant];
  const isConfirm = state?.kind === 'confirm';
  const confirmOpts = isConfirm ? (state.options as ConfirmOptions) : null;
  const notifyOpts = !isConfirm && state ? (state.options as NotifyOptions) : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div
              className={cn(
                'h-10 w-10 rounded-lg flex items-center justify-center shrink-0',
                VARIANT_STYLES[variant],
              )}
            >
              <Icon className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0 pt-0.5">
              <DialogTitle>{state?.options.title}</DialogTitle>
              {state?.options.description && (
                <DialogDescription className="mt-1.5">{state.options.description}</DialogDescription>
              )}
            </div>
          </div>
        </DialogHeader>
        <DialogFooter>
          {isConfirm && (
            <Button variant="outline" onClick={() => onClose(false)}>
              {confirmOpts?.cancelLabel ?? 'Cancel'}
            </Button>
          )}
          <Button
            variant={variant === 'destructive' ? 'destructive' : 'default'}
            onClick={() => onClose(true)}
            autoFocus
          >
            {isConfirm ? (confirmOpts?.confirmLabel ?? 'Confirm') : (notifyOpts?.okLabel ?? 'OK')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
