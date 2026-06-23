/**
 * Teams management: create/list orgs, manage members + roles, create invite links,
 * and (owner) buy seats / manage billing. All over the typed cloud RPC (orgs.*).
 * Members show a short account id (email enrichment is a future nicety); the
 * current user is marked "you". Shown in a modal from the Cloud menu.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Copy, Check, Trash2, CreditCard, Loader2, ChevronRight } from 'lucide-react';
import type { OrgMemberPublic, OrgPublic, OrgRolePublic } from '@mcp/api-bus';
import { Button } from '../../components/ui/button.js';
import { confirm } from '../../components/ui/prompt-dialog.js';
import { cn } from '../../lib/utils.js';
import { cloudCall } from '../../lib/cloud/cloud-client.js';
import { useCloudAction } from '../../lib/cloud/use-cloud-action.js';

type WriterOrViewer = 'admin' | 'member' | 'viewer';

function openExternal(url: string): void {
  (globalThis as { electronAPI?: { openExternal?: (u: string) => void } }).electronAPI?.openExternal?.(url);
}

export function TeamsSection({ selfAccountId }: { selfAccountId: string | null }) {
  const { t } = useTranslation('cloud');
  const { busy, error, run, setError } = useCloudAction();
  const [orgs, setOrgs] = useState<{ org: OrgPublic; role: OrgRolePublic }[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [members, setMembers] = useState<OrgMemberPublic[]>([]);
  const [name, setName] = useState('');
  const [inviteRole, setInviteRole] = useState<WriterOrViewer>('member');
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadOrgs = useCallback(async () => {
    const r = await cloudCall('orgs.list', undefined);
    setOrgs(r.orgs as { org: OrgPublic; role: OrgRolePublic }[]);
  }, []);

  useEffect(() => { setError(null); void run(loadOrgs); }, [run, loadOrgs, setError]);

  const myRole = orgs.find((o) => o.org.id === selected)?.role ?? null;
  const canManage = myRole === 'owner' || myRole === 'admin';

  const reloadMembers = async (orgId: string) => setMembers((await cloudCall('orgs.members', { orgId })).members as OrgMemberPublic[]);

  const openOrg = (id: string) => run(async () => { setSelected(id); setInviteLink(null); await reloadMembers(id); });
  const create = () => run(async () => { if (!name.trim()) return; await cloudCall('orgs.create', { name: name.trim() }); setName(''); await loadOrgs(); });
  const invite = () => run(async () => { if (!selected) return; setInviteLink((await cloudCall('orgs.invite', { orgId: selected, role: inviteRole })).url); });
  const changeRole = (accountId: string, role: WriterOrViewer) => run(async () => { if (!selected) return; await cloudCall('orgs.changeRole', { orgId: selected, accountId, role }); await reloadMembers(selected); });
  const remove = (accountId: string) => run(async () => {
    if (!selected || !(await confirm({ title: t('teams.removeConfirmTitle'), description: t('teams.removeConfirmBody'), tone: 'destructive' }))) return;
    await cloudCall('orgs.removeMember', { orgId: selected, accountId });
    await reloadMembers(selected);
  });
  const billing = (kind: 'checkout' | 'portal') => run(async () => {
    if (!selected) return;
    const r = kind === 'checkout' ? await cloudCall('orgs.billingCheckout', { orgId: selected }) : await cloudCall('orgs.billingPortal', { orgId: selected });
    openExternal(r.url);
  });
  const copyLink = async () => { if (!inviteLink) return; try { await navigator.clipboard.writeText(inviteLink); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ } };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t('teams.subtitle')}</p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <div className="flex items-center gap-2">
        <input className="flex-1 min-w-0 text-sm bg-background border rounded px-2 py-1.5" placeholder={t('teams.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />
        <Button size="sm" disabled={busy || !name.trim()} onClick={() => void create()}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} {t('teams.create')}
        </Button>
      </div>

      {orgs.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2 text-center">{t('teams.empty')}</p>
      ) : (
        <div className="border rounded-md divide-y divide-border/40">
          {orgs.map(({ org, role }) => (
            <div key={org.id}>
              <button className={cn('flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/50', selected === org.id && 'bg-muted/50')} onClick={() => void openOrg(org.id)}>
                <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', selected === org.id && 'rotate-90')} />
                <span className="flex-1 truncate font-medium">{org.name}</span>
                <span className="text-[11px] text-muted-foreground">{t(`teams.role.${role}`)}</span>
              </button>

              {selected === org.id ? (
                <div className="px-3 pb-3 space-y-2">
                  {/* Members */}
                  <div className="text-[11px] font-medium text-muted-foreground">{t('teams.members')}</div>
                  {members.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">{t('teams.noMembers')}</p>
                  ) : (
                    <div className="space-y-1">
                      {members.map((m) => (
                        <div key={m.accountId} className="flex items-center gap-2 text-xs">
                          <span className="flex-1 truncate font-mono text-[11px]">{m.accountId.slice(0, 8)}…{m.accountId === selfAccountId ? ` (${t('teams.you')})` : ''}</span>
                          {canManage && m.role !== 'owner' ? (
                            <select className="text-[11px] bg-background border rounded px-1 py-0.5" value={m.role} onChange={(e) => void changeRole(m.accountId, e.target.value as WriterOrViewer)}>
                              <option value="admin">{t('teams.role.admin')}</option>
                              <option value="member">{t('teams.role.member')}</option>
                              <option value="viewer">{t('teams.role.viewer')}</option>
                            </select>
                          ) : (
                            <span className="text-[11px] text-muted-foreground">{t(`teams.role.${m.role}`)}</span>
                          )}
                          {canManage && m.role !== 'owner' ? (
                            <Button size="icon" variant="ghost" className="h-6 w-6 hover:text-red-500" title={t('teams.remove')} onClick={() => void remove(m.accountId)}>
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Invite */}
                  {canManage ? (
                    <div className="space-y-1.5 pt-1">
                      <div className="flex items-center gap-2">
                        <select className="text-xs bg-background border rounded px-2 py-1" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as WriterOrViewer)}>
                          <option value="admin">{t('teams.role.admin')}</option>
                          <option value="member">{t('teams.role.member')}</option>
                          <option value="viewer">{t('teams.role.viewer')}</option>
                        </select>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void invite()}>{t('teams.invite')}</Button>
                      </div>
                      {inviteLink ? (
                        <div className="space-y-1">
                          <div className="text-[11px] text-muted-foreground">{t('teams.inviteLinkCreated')}</div>
                          <div className="flex items-center gap-2">
                            <code className="flex-1 min-w-0 truncate text-[11px] font-mono bg-background rounded px-2 py-1 border">{inviteLink}</code>
                            <Button size="icon" variant="ghost" className="h-6 w-6" title={t('teams.copy')} onClick={() => void copyLink()}>
                              {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {/* Billing (owner only) */}
                  {myRole === 'owner' ? (
                    <div className="flex items-center gap-2 pt-1">
                      <Button size="sm" disabled={busy} onClick={() => void billing('checkout')}>
                        <CreditCard className="h-3.5 w-3.5 mr-1" /> {t('teams.upgrade')}
                      </Button>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => void billing('portal')}>{t('teams.manageBilling')}</Button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
