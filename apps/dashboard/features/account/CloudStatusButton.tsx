/**
 * CodeStudio Cloud control in the top bar. A Cloud-icon button opens a compact
 * popover: signed-out shows a sign-in/up form; signed-in shows the account +
 * plan and action rows that open focused modals (2FA, subscription, sessions,
 * feedback). Replaces the old Admin "everything dumped on one page" panel.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Cloud, ShieldCheck, CreditCard, GitFork, MessageSquare, MonitorSmartphone, LogOut, Users, Loader2, type LucideIcon } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { cn } from '../../lib/utils.js';
import { cloudStartBrowserLogin, type OAuthProviderId } from '../../lib/cloud/cloud-client.js';
import { PORTAL_URL } from '../../lib/cloud/cloud-config.js';
import { useCloudAuth } from './useCloudAuth.js';
import { TwoFactorSection } from './TwoFactorSection.js';
import { SubscriptionSection } from './SubscriptionSection.js';
import { PlanMatrix } from './PlanMatrix.js';
import { TeamsSection } from './TeamsSection.js';
import { SessionsSection } from './SessionsSection.js';
import { FeedbackForm } from './FeedbackForm.js';
import { GitHubConnectionsSection } from './GitHubConnectionsSection.js';

type DialogKind = '2fa' | 'subscription' | 'teams' | 'sessions' | 'github' | 'feedback' | null;

const PROVIDERS: { id: OAuthProviderId; label: string }[] = [
  { id: 'google', label: 'Google' },
  { id: 'github', label: 'GitHub' },
  { id: 'microsoft', label: 'Microsoft' },
];

export function CloudStatusButton() {
  const { t } = useTranslation('cloud');
  const auth = useCloudAuth();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);

  const account = auth.session.state === 'logged_in' ? auth.session.account : null;
  const tier = auth.entitlements?.tier ?? 'free';
  const openDialog = (k: DialogKind) => { setOpen(false); setDialog(k); };
  const closeDialog = () => setDialog(null);

  // Desktop is OAuth-only: signing in opens the system browser and returns via the
  // loopback handoff (P7-B). Email/password lives on the web portal.
  const [pending, setPending] = useState<OAuthProviderId | null>(null);
  const [loginFailed, setLoginFailed] = useState(false);
  const signIn = async (id: OAuthProviderId) => {
    setLoginFailed(false);
    setPending(id);
    try {
      const r = await cloudStartBrowserLogin(id);
      if (!r.ok) setLoginFailed(true);
    } catch {
      setLoginFailed(true);
    } finally {
      setPending(null);
    }
  };
  const openPortal = () =>
    (globalThis as { electronAPI?: { openExternal?: (u: string) => void } }).electronAPI?.openExternal?.(`${PORTAL_URL}/login`);

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={t('title')} className="h-7 w-7">
                <Cloud className={cn('h-3.5 w-3.5', account ? 'text-primary' : undefined)} />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{t('title')}</TooltipContent>
        </Tooltip>
        <PopoverContent align="end" className="w-72 p-0">
          {account ? (
            <div className="p-1.5">
              <div className="px-2 py-1.5">
                <p className="truncate text-sm font-medium">{account.email}</p>
                <p className="text-xs text-muted-foreground">
                  {t('account.plan')}: {t(`tierName.${tier}`)}
                  {auth.entitlements?.status === 'trialing' ? ` · ${t('account.trialing')}` : ''}
                </p>
                {!account.emailVerified ? (
                  auth.verifySent ? (
                    <p className="mt-1 text-xs text-muted-foreground">{t('verify.sent')}</p>
                  ) : (
                    <button
                      type="button"
                      className="mt-1 text-xs text-amber-600 hover:underline"
                      disabled={auth.busy}
                      onClick={() => void auth.resendVerification()}
                    >
                      {t('account.emailUnverified')}
                    </button>
                  )
                ) : null}
                {tier === 'free' ? (
                  <Button size="sm" className="mt-2 w-full" onClick={() => openDialog('subscription')}>
                    {t('subscription.upgrade')}
                  </Button>
                ) : null}
              </div>
              <div className="my-1 h-px bg-border" />
              <MenuRow icon={ShieldCheck} label={t('menu.twofa')} onClick={() => openDialog('2fa')} />
              <MenuRow icon={CreditCard} label={t('menu.subscription')} onClick={() => openDialog('subscription')} />
              <MenuRow icon={Users} label={t('menu.teams')} onClick={() => openDialog('teams')} />
              <MenuRow icon={MonitorSmartphone} label={t('menu.sessions')} onClick={() => openDialog('sessions')} />
              <MenuRow icon={GitFork} label={t('menu.github')} onClick={() => openDialog('github')} />
              <MenuRow icon={MessageSquare} label={t('menu.feedback')} onClick={() => openDialog('feedback')} />
              <div className="my-1 h-px bg-border" />
              <MenuRow icon={LogOut} label={t('action.signOut')} onClick={() => { setOpen(false); void auth.session.signOut(); }} />
            </div>
          ) : (
            <div className="space-y-2 p-3">
              <div>
                <p className="text-sm font-medium">{t('title')}</p>
                <p className="text-xs text-muted-foreground">{t('gate.signInOAuth')}</p>
              </div>
              <div className="space-y-1.5">
                {PROVIDERS.map((p) => (
                  <Button
                    key={p.id}
                    variant="outline"
                    size="sm"
                    className="w-full justify-center gap-2"
                    disabled={pending != null}
                    onClick={() => void signIn(p.id)}
                  >
                    {pending === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    {t('gate.continueWith', { provider: p.label })}
                  </Button>
                ))}
              </div>
              {loginFailed ? <p className="text-xs text-destructive">{t('gate.oauthFailed')}</p> : null}
              <button type="button" className="w-full text-xs text-primary hover:underline" onClick={openPortal}>
                {t('gate.openPortal')}
              </button>
            </div>
          )}
        </PopoverContent>
      </Popover>

      <Modal open={dialog === '2fa'} onClose={closeDialog} title={t('twofaManage.title')}>
        <TwoFactorSection />
      </Modal>
      <Modal open={dialog === 'subscription'} onClose={closeDialog} title={t('subscription.title')} wide>
        <div className="space-y-4">
          <PlanMatrix tier={tier} />
          <SubscriptionSection tier={tier} />
        </div>
      </Modal>
      <Modal open={dialog === 'teams'} onClose={closeDialog} title={t('teams.title')} wide>
        <TeamsSection selfAccountId={account?.id ?? null} />
      </Modal>
      <Modal open={dialog === 'sessions'} onClose={closeDialog} title={t('sessions.title')}>
        <SessionsSection />
      </Modal>
      <Modal open={dialog === 'github'} onClose={closeDialog} title={t('github.title')} wide>
        <GitHubConnectionsSection />
      </Modal>
      <Modal open={dialog === 'feedback'} onClose={closeDialog} title={t('feedback.title')}>
        <FeedbackForm />
      </Modal>
    </>
  );
}

function MenuRow({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className={wide ? 'max-w-lg' : 'max-w-md'}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
