/**
 * Confirmation + selection for sharing SSH hosts with an org.
 *
 * WHY: the Share button used to publish EVERY host in the project — including
 * the globally-shared ones — with each password and private key decrypted and
 * inlined into the record, to every org member, with no preview and no
 * confirmation. This dialog makes the blast radius explicit before anything
 * leaves: which hosts, which of their secrets, and to whom.
 *
 * Both checkboxes default to OFF. Credentials-off is the useful common case —
 * a teammate connecting with their own key or agent needs the endpoint and
 * nothing else, so the default share moves no secret at all.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, KeyRound, Loader2, ShieldAlert, UploadCloud, Users } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog.js';
import { Button } from '../../../components/ui/button.js';
import { cn } from '../../../lib/utils.js';
import { buildShareCandidates, summarizeShare, type ShareCandidate, type ShareChoice } from './share-selection.js';
import type { ShareRecipient } from './use-ssh-vault-sync.js';
import type { SshHost } from '../types.js';

interface Props {
  open: boolean;
  orgId: string;
  orgName: string;
  hosts: SshHost[];
  busy: boolean;
  onOpenChange: (v: boolean) => void;
  loadRecipients: (orgId: string) => Promise<ShareRecipient[]>;
  onConfirm: (selection: ShareChoice[]) => void;
}

interface RowState {
  selected: boolean;
  includeCredentials: boolean;
}

export function ShareWithOrgDialog({ open, orgId, orgName, hosts, busy, onOpenChange, loadRecipients, onConfirm }: Props) {
  const { t } = useTranslation('ssh');
  const candidates = useMemo(() => buildShareCandidates(hosts), [hosts]);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [recipients, setRecipients] = useState<ShareRecipient[] | null>(null);
  const [recipientError, setRecipientError] = useState<string | null>(null);

  // Reset to "nothing selected" every time the dialog opens: a selection must
  // never survive from a previous org or a previous session.
  useEffect(() => {
    if (!open) return;
    setRows({});
    setRecipients(null);
    setRecipientError(null);
    let alive = true;
    void loadRecipients(orgId)
      .then((r) => alive && setRecipients(r))
      .catch((e) => alive && setRecipientError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [open, orgId, loadRecipients]);

  const selection: ShareChoice[] = useMemo(
    () =>
      Object.entries(rows)
        .filter(([, s]) => s.selected)
        .map(([hostKey, s]) => ({ hostKey, includeCredentials: s.includeCredentials })),
    [rows],
  );
  const impact = useMemo(() => summarizeShare(candidates, selection), [candidates, selection]);

  // Both flags default OFF for a row the user hasn't touched yet.
  const set = (hostKey: string, patch: Partial<RowState>) =>
    setRows((prev) => {
      const base: RowState = prev[hostKey] ?? { selected: false, includeCredentials: false };
      return { ...prev, [hostKey]: { ...base, ...patch } };
    });

  const willReceive = recipients?.filter((r) => !r.keyChanged) ?? [];
  const skipped = recipients?.filter((r) => r.keyChanged) ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UploadCloud className="h-4 w-4" /> {t('vault.share.title', { org: orgName })}
          </DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">{t('vault.share.subtitle')}</p>

        {/* Recipients — shown BEFORE the selection commits, because the TOFU pin
            for a first-seen member is written at share time, so this is the only
            moment an unexpected recipient can still be noticed. */}
        <div className="rounded-md border p-2 space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Users className="h-3.5 w-3.5" />
            {recipients == null
              ? t('vault.share.loadingRecipients')
              : t('vault.share.recipients', { count: willReceive.length })}
          </div>
          {recipientError ? <p className="text-[11px] text-destructive">{recipientError}</p> : null}
          {willReceive.map((r) => (
            <div key={r.accountId} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="truncate">{r.accountId}</span>
              <span className="flex items-center gap-1.5 shrink-0 font-mono text-muted-foreground">
                {r.fingerprint}
                {!r.pinned && (
                  <span className="rounded bg-amber-500/15 px-1 text-amber-600 dark:text-amber-400 font-sans">
                    {t('vault.share.firstSeen')}
                  </span>
                )}
              </span>
            </div>
          ))}
          {skipped.length > 0 && (
            <p className="flex items-start gap-1 text-[11px] text-destructive">
              <ShieldAlert className="h-3 w-3 mt-0.5 shrink-0" />
              {t('vault.share.keyChangedSkipped', { count: skipped.length })}
            </p>
          )}
        </div>

        {/* Host selection */}
        <div className="max-h-64 overflow-y-auto rounded-md border divide-y">
          {candidates.length === 0 && (
            <p className="p-3 text-center text-[11px] text-muted-foreground">{t('panel.noHosts')}</p>
          )}
          {candidates.map((c) => (
            <HostRow key={c.hostKey} c={c} state={rows[c.hostKey]} onChange={(p) => set(c.hostKey, p)} t={t} />
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          <p className={cn('text-[11px]', impact.secrets > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}>
            {impact.secrets > 0 && <AlertTriangle className="mr-1 inline h-3 w-3" />}
            {t('vault.share.summary', {
              hosts: impact.hosts,
              withCredentials: impact.withCredentials,
              members: willReceive.length,
            })}
          </p>
          <Button
            size="sm"
            variant={impact.secrets > 0 ? 'destructive' : 'default'}
            disabled={busy || selection.length === 0 || recipients == null}
            onClick={() => onConfirm(selection)}
          >
            {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="mr-1 h-3.5 w-3.5" />}
            {t('vault.share.confirm')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function HostRow({
  c,
  state,
  onChange,
  t,
}: {
  c: ShareCandidate;
  state: RowState | undefined;
  onChange: (p: Partial<RowState>) => void;
  t: (k: string, o?: Record<string, unknown>) => string;
}) {
  const selected = !!state?.selected;
  const hasSecrets = c.secretKinds.length > 0;
  return (
    <div className="flex items-start gap-2 px-2 py-1.5 text-xs">
      <input
        type="checkbox"
        className="mt-0.5 shrink-0"
        checked={selected}
        aria-label={c.label}
        onChange={(e) => onChange({ selected: e.target.checked })}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium">{c.label}</span>
          {c.isShared && (
            <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">{t('panel.shared')}</span>
          )}
        </div>
        <div className="truncate font-mono text-[10px] text-muted-foreground">{c.endpoint}</div>
        {selected && hasSecrets && (
          <label className="mt-1 flex items-center gap-1.5 text-[10px] text-amber-600 dark:text-amber-400">
            <input
              type="checkbox"
              checked={!!state?.includeCredentials}
              onChange={(e) => onChange({ includeCredentials: e.target.checked })}
            />
            <KeyRound className="h-3 w-3" />
            {t('vault.share.includeCredentials', {
              kinds: c.secretKinds.map((k) => t(`vault.share.secretKind.${k}`)).join(', '),
            })}
          </label>
        )}
        {selected && !hasSecrets && (
          <p className="mt-0.5 text-[10px] text-muted-foreground">{t('vault.share.noSecrets')}</p>
        )}
      </div>
    </div>
  );
}
