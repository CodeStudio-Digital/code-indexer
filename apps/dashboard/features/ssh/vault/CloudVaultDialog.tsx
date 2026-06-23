/**
 * Cloud vault dialog — unlock with a vault passphrase, then sync the project's
 * SSH hosts end-to-end encrypted. Entitlement is enforced server-side
 * (`sshVault`); a free/anon caller gets a typed error inline. The passphrase
 * derives the encryption key locally and is never sent anywhere.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck, Copy, Check, Loader2, Link2, Lock, Users, UploadCloud, DownloadCloud } from 'lucide-react';
import type { OrgPublic, OrgRolePublic } from '@mcp/api-bus';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog.js';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../../../components/ui/select.js';
import { confirm } from '../../../components/ui/prompt-dialog.js';
import { UpgradeNotice } from '../../../components/UpgradeNotice.js';
import { cloudCall } from '../../../lib/cloud/cloud-client.js';
import { useEntitlements } from '../../account/useEntitlements.js';
import { useSshVaultSync } from './use-ssh-vault-sync.js';

interface Props {
  projectId: number;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

/** Map hook error codes to friendly copy (security codes get explicit, alarming messages). */
function vaultErrorMessage(error: string, t: (k: string) => string): string {
  if (error === 'wrong_passphrase') return t('vault.wrongPassphrase');
  if (error === 'no_grant') return t('vault.noGrant');
  if (error === 'grant_unverified') return t('vault.grantUnverified');
  if (error === 'granter_key_changed') return t('vault.granterKeyChanged');
  if (error.startsWith('member_key_changed')) return t('vault.memberKeyChanged');
  return error;
}

export function CloudVaultDialog({ projectId, open, onOpenChange }: Props) {
  const { t } = useTranslation('ssh');
  const { has } = useEntitlements();
  const { workspaceId, busy, error, last, unlocked, unlock, sync, linkWorkspace, shareWithOrg, pullTeam } = useSshVaultSync(projectId);
  const [passphrase, setPassphrase] = useState('');
  const [copied, setCopied] = useState(false);
  const [joinId, setJoinId] = useState('');
  const [orgs, setOrgs] = useState<{ org: OrgPublic; role: OrgRolePublic }[]>([]);
  const [orgId, setOrgId] = useState('');

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

        {!unlocked ? (
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
            <Button size="sm" disabled={!entitled || busy || !passphrase} onClick={() => void unlockAndSync()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <ShieldCheck className="h-3.5 w-3.5 mr-1" />}
              {busy ? t('vault.unlocking') : t('vault.unlock')}
            </Button>
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
                    <Button size="sm" variant="outline" disabled={busy || !orgId} onClick={() => void shareWithOrg(orgId)}>
                      <UploadCloud className="h-3.5 w-3.5 mr-1" /> {t('vault.share')}
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
    </Dialog>
  );
}
