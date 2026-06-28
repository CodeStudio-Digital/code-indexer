/**
 * A small, props-driven "this is a paid feature" banner with an Upgrade button
 * that opens Stripe-hosted checkout in the system browser. No literal copy lives
 * here — the parent passes already-translated `message`/`cta` (so each caller uses
 * its own i18n namespace and the literal-baseline check stays clean).
 */
import { useState } from 'react';
import { Sparkles, Loader2 } from 'lucide-react';
import { Button } from './ui/button.js';
import { cloudCall } from '../lib/cloud/cloud-client.js';
import { CloudError } from '../lib/cloud/cloud-errors.js';
import { markCheckoutPending } from '../lib/cloud/checkout-pending.js';

function openExternal(url: string): void {
  (globalThis as { electronAPI?: { openExternal?: (u: string) => void } }).electronAPI?.openExternal?.(url);
}

export function UpgradeNotice({ message, cta }: { message: string; cta: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upgrade = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await cloudCall('billing.checkout', undefined);
      markCheckoutPending();
      openExternal(url);
    } catch (e) {
      setError(e instanceof CloudError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
      <div className="flex items-start gap-2">
        <Sparkles className="h-4 w-4 shrink-0 text-amber-500 mt-0.5" />
        <p className="text-xs text-muted-foreground">{message}</p>
      </div>
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
      <Button size="sm" disabled={busy} onClick={() => void upgrade()}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} {cta}
      </Button>
    </div>
  );
}
