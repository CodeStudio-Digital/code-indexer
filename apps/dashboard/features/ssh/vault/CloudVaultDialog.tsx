/**
 * Cloud vault dialog — unlock with a vault passphrase, then sync the project's
 * SSH hosts end-to-end encrypted. Entitlement is enforced server-side
 * (`sshVault`); a free/anon caller gets a typed error inline. The passphrase
 * derives the encryption key locally and is never sent anywhere.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck, Copy, Check, Loader2, Link2, Lock, Users, UploadCloud, DownloadCloud, KeyRound, AlertTriangle } from 'lucide-react';
import type { OrgPublic, OrgRolePublic } from '@mcp/api-bus';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog.js';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../../../components/ui/select.js';
import { confirm } from '../../../components/ui/prompt-dialog.js';
import { UpgradeNotice } from '../../../components/UpgradeNotice.js';
import { cloudCall } from '../../../lib/cloud/cloud-client.js';
import { useEntitlements } from '../../account/useEntitlements.js';
import { listHosts } from '../api.js';
import { useSshVaultSync } from './use-ssh-vault-sync.js';
import { ShareWithOrgDialog } from './ShareWithOrgDialog.js';
import type { SshHost } from '../types.js';

interface Props {
  projectId: number;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

/** Map hook error codes to friendly copy (security codes get explicit, alarming messages). */
function vaultErrorMessage(error: string, t: (k: string) => string): string {
  if (error === 'wrong_passphrase') return t('vault.wrongPassphrase');
  if (error === 'wrong_recovery_key') return t('vault.wrongRecoveryKey');
  if (error === 'no_recovery') return t('vault.noRecovery');
  if (error === 'no_vault') return t('vault.noVault');
  if (error === 'no_grant') return t('vault.noGrant');
  if (error === 'grant_unverified') return t('vault.grantUnverified');
  if (error === 'granter_key_changed') return t('vault.granterKeyChanged');
  if (error.startsWith('member_key_changed')) return t('vault.memberKeyChanged');
  return error;
}

export function CloudVaultDialog({ projectId, open, onOpenChange }: Props) {
  const { t } = useTranslation('ssh');
  const { has } = useEntitlements();
  const { workspaceId, busy, error, last, unlocked, recoveryEnabled, unlock, unlockWithRecovery, enrollRecoveryKey, sync, linkWorkspace, shareWithOrg, listShareRecipients, pullTeam } = useSshVaultSync(projectId);
  const [passphrase, setPassphrase] = useState('');
  const [copied, setCopied] = useState(false);
  const [joinId, setJoinId] = useState('');
  const [orgs, setOrgs] = useState<{ org: OrgPublic; role: OrgRolePublic }[]>([]);
  const [orgId, setOrgId] = useState('');
  // Recovery-key flows: locked "forgot passphrase" recovery + unlocked enroll (show-once).
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState('');
  const [newPassphrase, setNewPassphrase] = useState('');
  const [generated, setGenerated] = useState<string | null>(null);
  const [recoveryCopied, setRecoveryCopied] = useState(false);
  // Share is gated behind an explicit selection dialog — see ShareWithOrgDialog.
  const [shareOpen, setShareOpen] = useState(false);
  const [shareHosts, setShareHosts] = useState<SshHost[]>([]);

  const entitled = has('sshVault');
  const teamEntitled = has('teamSshVault');

  // Load my teams once unlocked + entitled (for the share/pull section).
  useEffect(() => {
    if (!open || !unlocked || !teamEntitled) return;
    let alive = true;
    void cloudCall('orgs.list', undefined)
      .then((r) => {
        if (alive) setOrgs(r.orgs);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [open, unlocked, teamEntitled]);

  const selectedRole = orgs.find((o) => o.org.id === orgId)?.role;
  const canShare = selectedRole === 'owner' || selectedRole === 'admin';

  const unlockAndSync = async () => {
    if (!passphrase) return;
    try {
      await unlock(passphrase);
      await sync();
    } catch {
      /* error is surfaced via the hook's `error` state */
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(workspaceId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  const recoverAndReset = async () => {
    if (!recoveryKey.trim() || !newPassphrase) return;
    try {
      await unlockWithRecovery(recoveryKey.trim(), newPassphrase);
      setRecoveryMode(false);
      setRecoveryKey('');
      setNewPassphrase('');
      await sync();
    } catch {
      /* surfaced via hook error */
    }
  };

  const enroll = async () => {
    try {
      setGenerated(await enrollRecoveryKey());
    } catch {
      /* surfaced via hook error */
    }
  };

  const copyRecovery = async () => {
    if (!generated) return;
    try {
      await navigator.clipboard.writeText(generated);
      setRecoveryCopied(true);
      setTimeout(() => setRecoveryCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  // Load the host list only when the user actually opens the share dialog, so
  // the rows reflect the current state rather than whatever was cached earlier.
  const openShare = async () => {
    try {
      setShareHosts(await listHosts(projectId));
    } catch {
      setShareHosts([]);
    }
    setShareOpen(true);
  };

  const join = async () => {
    if (!joinId.trim()) return;
    if (await confirm({ title: t('vault.linkConfirmTitle'), description: t('vault.linkConfirmBody'), tone: 'destructive' })) {
      linkWorkspace(joinId);
      setJoinId('');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" /> {t('vault.title')}
          </DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">{t('vault.subtitle')}</p>
        {!entitled ? <UpgradeNotice message={t('vault.upgradeMsg')} cta={t('vault.upgradeCta')} /> : null}
        {error ? <p className="text-xs text-destructive">{vaultErrorMessage(error, t)}</p> : null}

        {!unlocked && !recoveryMode ? (
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground">{t('vault.passphrase')}</div>
            <Input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              disabled={!entitled || busy}
              onKeyDown={(e) => e.key === 'Enter' && void unlockAndSync()}
            />
            <p className="text-[11px] text-amber-500 flex items-start gap-1">
              <Lock className="h-3 w-3 mt-0.5 shrink-0" />
              {t('vault.passphraseHint')}
            </p>
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={!entitled || busy || !passphrase} onClick={() => void unlockAndSync()}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <ShieldCheck className="h-3.5 w-3.5 mr-1" />}
                {busy ? t('vault.unlocking') : t('vault.unlock')}
              </Button>
              <button type="button" disabled={!entitled || busy} className="text-[11px] text-muted-foreground hover:text-foreground underline disabled:opacity-50" onClick={() => setRecoveryMode(true)}>
                {t('vault.forgotPassphrase')}
              </button>
            </div>
          </div>
        ) : !unlocked && recoveryMode ? (
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <KeyRound className="h-3.5 w-3.5" /> {t('vault.recoveryTitle')}
            </div>
            <Input
              value={recoveryKey}
              onChange={(e) => setRecoveryKey(e.target.value)}
              disabled={!entitled || busy}
              placeholder={t('vault.recoveryKeyPlaceholder')}
              className="font-mono text-xs"
            />
            <div className="text-[11px] text-muted-foreground">{t('vault.newPassphrase')}</div>
            <Input
              type="password"
              value={newPassphrase}
              onChange={(e) => setNewPassphrase(e.target.value)}
              disabled={!entitled || busy}
              onKeyDown={(e) => e.key === 'Enter' && void recoverAndReset()}
            />
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={!entitled || busy || !recoveryKey.trim() || !newPassphrase} onClick={() => void recoverAndReset()}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <KeyRound className="h-3.5 w-3.5 mr-1" />}
                {busy ? t('vault.recovering') : t('vault.recoverAndReset')}
              </Button>
              <button type="button" disabled={busy} className="text-[11px] text-muted-foreground hover:text-foreground underline disabled:opacity-50" onClick={() => setRecoveryMode(false)}>
                {t('dialog.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={busy} onClick={() => void sync()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <ShieldCheck className="h-3.5 w-3.5 mr-1" />}
              {busy ? t('vault.syncing') : t('vault.syncNow')}
            </Button>
            {last ? (
              <span className="text-[11px] text-muted-foreground">
                {t('vault.lastResult', { pushed: last.pushed, applied: last.pulledApplied, conflicts: last.conflicts })}
              </span>
            ) : null}
          </div>
        )}

        {unlocked ? (
          <div className="space-y-1.5 border-t pt-3">
            <div className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <KeyRound className="h-3.5 w-3.5" /> {t('vault.recoverySection')}
            </div>
            {generated ? (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 space-y-1.5">
                <p className="text-[11px] text-amber-600 dark:text-amber-400 flex items-start gap-1">
                  <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" /> {t('vault.recoveryShownOnce')}
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-w-0 break-all text-[11px] font-mono bg-background rounded px-2 py-1 border select-all">{generated}</code>
                  <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" title={t('vault.copy')} onClick={() => void copyRecovery()}>
                    {recoveryCopied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>
                <Button size="sm" variant="outline" onClick={() => setGenerated(null)}>
                  <Check className="h-3.5 w-3.5 mr-1" /> {t('vault.recoverySaved')}
                </Button>
              </div>
            ) : recoveryEnabled ? (
              <p className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                <Check className="h-3 w-3 shrink-0" /> {t('vault.recoveryActive')}
              </p>
            ) : (
              <>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void enroll()}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <KeyRound className="h-3.5 w-3.5 mr-1" />}
                  {t('vault.generateRecovery')}
                </Button>
                <p className="text-[11px] text-muted-foreground">{t('vault.recoveryHint')}</p>
              </>
            )}
          </div>
        ) : null}

        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">{t('vault.workspace')}</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate text-[11px] font-mono bg-background rounded px-2 py-1 border">{workspaceId}</code>
            <Button size="icon" variant="ghost" className="h-7 w-7" title={t('vault.copy')} onClick={() => void copy()}>
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">{t('vault.linkLabel')}</div>
          <div className="flex items-center gap-2">
            <input
              className="flex-1 min-w-0 text-xs bg-background border rounded px-2 py-1.5 font-mono"
              placeholder={t('vault.linkPlaceholder')}
              value={joinId}
              onChange={(e) => setJoinId(e.target.value)}
            />
            <Button size="sm" variant="outline" disabled={!joinId.trim()} onClick={() => void join()}>
              <Link2 className="h-3.5 w-3.5 mr-1" /> {t('vault.link')}
            </Button>
          </div>
        </div>

        {unlocked && teamEntitled ? (
          <div className="space-y-1.5 border-t pt-3">
            <div className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" /> {t('vault.teams')}
            </div>
            {orgs.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">{t('vault.noOrgs')}</p>
            ) : (
              <>
                <Select value={orgId} onValueChange={setOrgId}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue placeholder={t('vault.selectOrg')} /></SelectTrigger>
                  <SelectContent>
                    {orgs.map((o) => (
                      <SelectItem key={o.org.id} value={o.org.id}>{o.org.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex items-center gap-2">
                  {canShare ? (
                    <Button size="sm" variant="outline" disabled={busy || !orgId} onClick={() => void openShare()}>
                      <UploadCloud className="h-3.5 w-3.5 mr-1" /> {t('vault.share.confirm')}
                    </Button>
                  ) : null}
                  <Button size="sm" variant="outline" disabled={busy || !orgId} onClick={() => void pullTeam(orgId)}>
                    <DownloadCloud className="h-3.5 w-3.5 mr-1" /> {t('vault.pullTeam')}
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">{t('vault.teamHint')}</p>
              </>
            )}
          </div>
        ) : null}
      </DialogContent>

      <ShareWithOrgDialog
        open={shareOpen}
        orgId={orgId}
        orgName={orgs.find((o) => o.org.id === orgId)?.org.name ?? orgId}
        hosts={shareHosts}
        busy={busy}
        onOpenChange={setShareOpen}
        loadRecipients={listShareRecipients}
        onConfirm={(selection) => {
          setShareOpen(false);
          void shareWithOrg(orgId, selection);
        }}
      />
    </Dialog>
  );
}
