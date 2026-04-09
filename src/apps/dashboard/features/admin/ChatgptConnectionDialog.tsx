import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import type { ChatgptFlowState } from './types.js';

interface ChatgptConnectionDialogProps {
  onClose: () => void;
  onConnected: (providerId?: string) => Promise<void> | void;
}

export function ChatgptConnectionDialog({ onClose, onConnected }: ChatgptConnectionDialogProps) {
  const [flow, setFlow] = useState<ChatgptFlowState>({ state: 'idle' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch('/api/admin/oauth/openai/start', { method: 'POST' });
        const j = (await r.json()) as { authorize_url?: string; state?: string; error?: string };
        if (!j.authorize_url || !j.state) throw new Error(j.error ?? 'unexpected response');
        if (cancelled) return;
        setFlow({ state: 'waiting', authorizeUrl: j.authorize_url, flowState: j.state });
        // Open the OpenAI authorize page in a new tab. The loopback server on
        // :1455 will catch the redirect; we just poll our own backend.
        window.open(j.authorize_url, '_blank', 'noopener,noreferrer');
        const poll = async () => {
          if (cancelled) return;
          try {
            const p = await fetch('/api/admin/oauth/openai/poll', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ state: j.state }),
            });
            const pj = (await p.json()) as {
              status: string;
              error?: string;
              provider_id?: string;
              model_count?: number;
            };
            if (pj.status === 'authorized') {
              if (cancelled) return;
              setFlow({ state: 'success', providerId: pj.provider_id, modelCount: pj.model_count });
              await onConnected(pj.provider_id);
              return;
            }
            if (pj.status === 'expired' || pj.status === 'error') {
              if (!cancelled) setFlow({ state: 'error', message: pj.error ?? 'flow expired' });
              return;
            }
            setTimeout(() => {
              void poll();
            }, 2000);
          } catch (e) {
            if (!cancelled) setFlow({ state: 'error', message: (e as Error).message });
          }
        };
        void poll();
      } catch (e) {
        if (!cancelled) setFlow({ state: 'error', message: (e as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Connect ChatGPT</DialogTitle>
        </DialogHeader>
        {flow.state === 'waiting' && (
          <div className="space-y-3 text-sm">
            <p>
              A new tab was opened to sign in at <span className="font-mono">auth.openai.com</span>. After you
              authorize, this dialog will update automatically.
            </p>
            <p className="text-xs text-muted-foreground">
              If the tab didn't open,{' '}
              <a
                href={flow.authorizeUrl}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline"
              >
                click here
              </a>
              .
            </p>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Waiting for authorization…
            </div>
          </div>
        )}
        {flow.state === 'success' && (
          <div className="text-sm text-emerald-600">
            ChatGPT connected successfully
            {typeof flow.modelCount === 'number' ? ` — ${flow.modelCount} models loaded` : ''}.
            The provider is now available in the Chat tab.
          </div>
        )}
        {flow.state === 'error' && <div className="text-sm text-red-600 break-all">{flow.message}</div>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
