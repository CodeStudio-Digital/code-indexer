/**
 * Host-key trust prompt (TOFU). Shown when a connection hits an unknown or
 * CHANGED host key. The user verifies the fingerprint and accepts/declines;
 * the parent persists the key (`ssh.trustHostKey`) and retries on accept.
 *
 * The `changed` variant is intentionally alarming — a changed key can mean a
 * man-in-the-middle — and requires an explicit "replace key" confirmation.
 */

import { useTranslation } from 'react-i18next';
import { ShieldQuestion, ShieldAlert } from 'lucide-react';
import type { SshHostKeyInfo } from '@mcp/api-bus';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../../components/ui/dialog.js';
import { Button } from '../../components/ui/button.js';
import type { HostKeyDecision } from './api.js';

interface HostKeyTrustPromptProps {
  info: SshHostKeyInfo;
  mode: HostKeyDecision;
  onDecision: (accepted: boolean) => void;
}

export function HostKeyTrustPrompt({ info, mode, onDecision }: HostKeyTrustPromptProps) {
  const { t } = useTranslation('ssh');
  const changed = mode === 'changed';

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onDecision(false); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {changed ? (
              <ShieldAlert className="h-5 w-5 text-red-500" />
            ) : (
              <ShieldQuestion className="h-5 w-5 text-amber-500" />
            )}
            {changed ? t('trust.titleChanged') : t('trust.titleUnknown')}
          </DialogTitle>
          <DialogDescription>
            {changed
              ? t('trust.bodyChanged', { host: `${info.host}:${info.port}` })
              : t('trust.bodyUnknown', { host: `${info.host}:${info.port}` })}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border bg-muted/40 p-3 text-sm font-mono space-y-1">
          <div className="flex gap-2">
            <span className="text-muted-foreground w-24 shrink-0 font-sans">{t('trust.keyType')}</span>
            <span className="break-all">{info.keyType}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground w-24 shrink-0 font-sans">{t('trust.fingerprint')}</span>
            <span className="break-all">{info.fingerprint}</span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onDecision(false)}>
            {t('trust.cancel')}
          </Button>
          <Button variant={changed ? 'destructive' : 'default'} onClick={() => onDecision(true)}>
            {changed ? t('trust.acceptChanged') : t('trust.accept')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
