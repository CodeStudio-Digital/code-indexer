/** Teams — organizations the user belongs to, with members, invites, and role
 *  management. Owners/admins can invite (emailed or link) and remove members. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Users, ShieldCheck, KeyRound } from 'lucide-react';
import type { OrgMemberPublic, OrgPublic, OrgRolePublic } from '@mcp/api-bus';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { confirm } from '../lib/confirm.js';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Spinner } from '../lib/ui.js';

type Membership = { org: OrgPublic; role: OrgRolePublic };

const SELECT_CLS = 'h-9 rounded-md border border-input bg-transparent px-2 text-sm';

const ROLE_TONE: Record<OrgRolePublic, 'default' | 'success' | 'warning' | 'muted' | 'info'> = {
  owner: 'success',
  admin: 'info',
  member: 'default',
  viewer: 'muted',
};

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export function TeamsPage() {
  const { account } = useAuth();
  const [orgs, setOrgs] = useState<Membership[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // create-team form
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setOrgs((await api.orgsList()).orgs);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load teams.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    setError(null);
    try {
      await api.orgCreate(trimmed);
      setName('');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not create team.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Teams</h1>
        <p className="text-sm text-muted-foreground">Organizations you belong to.</p>
      </div>

      {error ? <Alert>{error}</Alert> : null}

      <Card>
        <CardHeader>
          <CardTitle>Create team</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Team name"
              className="max-w-xs"
            />
            <Button type="submit" size="sm" loading={creating} disabled={!name.trim()}>
              Create team
            </Button>
          </form>
        </CardContent>
      </Card>

      {!orgs ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading…
        </div>
      ) : orgs.length === 0 ? (
        <p className="text-sm text-muted-foreground">You're not in any team yet. Create one above.</p>
      ) : (
        <div className="space-y-4">
          {orgs.map((m) => (
            <OrgCard key={m.org.id} org={m.org} role={m.role} currentAccountId={account?.id ?? null} />
          ))}
        </div>
      )}
    </div>
  );
}

function OrgCard({
  org,
  role,
  currentAccountId,
}: {
  org: OrgPublic;
  role: OrgRolePublic;
  currentAccountId: string | null;
}) {
  const [members, setMembers] = useState<OrgMemberPublic[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canManage = role === 'owner' || role === 'admin';

  const load = useCallback(async () => {
    setError(null);
    try {
      setMembers((await api.orgMembers(org.id)).members);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load members.');
    }
  }, [org.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const removeMember = async (accountId: string) => {
    if (
      !(await confirm({
        title: 'Remove this member from the team?',
        confirmLabel: 'Remove',
        tone: 'destructive',
      }))
    )
      return;
    setError(null);
    try {
      await api.orgRemoveMember(org.id, accountId);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not remove member.');
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
          <CardTitle className="flex-1">{org.name}</CardTitle>
          <Badge tone={ROLE_TONE[role]}>{role}</Badge>
          <Badge tone="muted">{org.kind}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? <Alert>{error}</Alert> : null}

        {!members ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading members…
          </div>
        ) : members.length === 0 ? (
          <p className="text-sm text-muted-foreground">No members.</p>
        ) : (
          <div className="divide-y rounded-md border">
            {members.map((mem) => (
              <div key={mem.accountId} className="flex items-center gap-2 px-3 py-2">
                <span className="flex-1 truncate font-mono text-xs text-muted-foreground">{shortId(mem.accountId)}</span>
                <Badge tone={ROLE_TONE[mem.role]}>{mem.role}</Badge>
                {canManage && mem.role !== 'owner' && mem.accountId !== currentAccountId ? (
                  <Button variant="ghost" size="sm" onClick={() => void removeMember(mem.accountId)}>
                    Remove
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {canManage ? <InviteForm orgId={org.id} /> : null}
        {canManage ? <VaultSection orgId={org.id} /> : null}
        {canManage ? <SsoSection orgId={org.id} /> : null}
      </CardContent>
    </Card>
  );
}

/** Single sign-on (OIDC) config for the org admin. Self-hides when the server
 *  doesn't offer SSO; shows an Enterprise hint when the org isn't entitled; else a
 *  config form. The client secret is write-only (never echoed back). */
function SsoSection({ orgId }: { orgId: string }) {
  const [state, setState] = useState<'loading' | 'unavailable' | 'needsEnterprise' | 'ready'>('loading');
  const [configured, setConfigured] = useState(false);
  const [issuer, setIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [domains, setDomains] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api.ssoGetConfig(orgId);
      if (r.configured) {
        setConfigured(true);
        setIssuer(r.issuer);
        setClientId(r.clientId);
        setDomains(r.allowedDomains.join(', '));
        setEnabled(r.enabled);
      }
      setState('ready');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'sso_unconfigured') setState('unavailable');
      else if (e instanceof ApiError && e.code === 'entitlement_required') setState('needsEnterprise');
      else {
        setState('ready');
        setError(e instanceof ApiError ? e.message : 'Could not load SSO.');
      }
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setError(null);
    setMsg(null);
    if (!issuer.trim() || !clientId.trim()) return setError('Issuer and client ID are required.');
    if (!clientSecret) return setError('Re-enter the client secret to save.');
    const allowedDomains = domains.split(',').map((d) => d.trim()).filter(Boolean);
    if (allowedDomains.length === 0) return setError('Add at least one allowed email domain.');
    setBusy(true);
    try {
      await api.ssoSetConfig(orgId, { issuer: issuer.trim(), clientId: clientId.trim(), clientSecret, allowedDomains, enabled });
      setClientSecret('');
      setConfigured(true);
      setMsg('SSO settings saved.');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save SSO.');
    } finally {
      setBusy(false);
    }
  };

  if (state === 'loading' || state === 'unavailable') return null;
  if (state === 'needsEnterprise') {
    return (
      <div className="space-y-1 rounded-md border p-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" /> Single sign-on
        </div>
        <p className="text-xs text-muted-foreground">SSO is available on the Enterprise plan.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" /> Single sign-on (OIDC)
        {configured ? <Badge tone={enabled ? 'success' : 'muted'}>{enabled ? 'enabled' : 'disabled'}</Badge> : null}
      </div>
      {error ? <Alert>{error}</Alert> : null}
      <p className="text-xs text-muted-foreground">Register this redirect URI with your identity provider:</p>
      <div className="break-all rounded bg-muted px-2 py-1 font-mono text-xs select-all">{api.ssoCallbackUrl()}</div>
      <div className="space-y-2">
        <div className="space-y-1">
          <Label htmlFor={`sso-issuer-${orgId}`}>Issuer URL</Label>
          <Input id={`sso-issuer-${orgId}`} value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://idp.example.com" />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`sso-client-${orgId}`}>Client ID</Label>
          <Input id={`sso-client-${orgId}`} value={clientId} onChange={(e) => setClientId(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`sso-secret-${orgId}`}>Client secret</Label>
          <Input id={`sso-secret-${orgId}`} type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={configured ? 'Re-enter to change' : ''} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`sso-domains-${orgId}`}>Allowed email domains</Label>
          <Input id={`sso-domains-${orgId}`} value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="acme.com, acme.io" />
          <p className="text-xs text-muted-foreground">Only verified emails on these domains may sign in via SSO.</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
        </label>
      </div>
      <Button size="sm" loading={busy} onClick={() => void save()}>
        Save SSO
      </Button>
      {msg ? <p className="text-xs text-emerald-600">{msg}</p> : null}
    </div>
  );
}

/** SSH vault management (admin): grant-ready member count + key rotation. The portal
 *  manages distribution metadata only — it never sees vault contents or keys. */
function VaultSection({ orgId }: { orgId: string }) {
  const [keyed, setKeyed] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setKeyed((await api.vaultMembers(orgId)).members.length);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load vault status.');
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rotate = async () => {
    if (
      !(await confirm({
        title: 'Rotate the team vault key?',
        description:
          'Everyone must pull again, and anyone removed loses access to future changes. Re-share from the desktop app to re-grant members.',
        confirmLabel: 'Rotate key',
        tone: 'destructive',
      }))
    )
      return;
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await api.vaultRotate(orgId, `org:${orgId}`);
      setMsg('Vault key rotated. Re-share from the desktop app to re-grant the remaining members.');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not rotate the vault key.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <ShieldCheck className="h-4 w-4 shrink-0 text-muted-foreground" /> SSH vault
      </div>
      {error ? <Alert>{error}</Alert> : null}
      <p className="text-xs text-muted-foreground">
        {keyed == null ? 'Checking…' : `${keyed} member${keyed === 1 ? '' : 's'} published a vault key (grant-ready).`}
      </p>
      <p className="text-xs text-muted-foreground">
        Zero-knowledge: the server never sees vault contents. Rotating the key revokes access for anyone without a fresh grant — do this after removing a member.
      </p>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void rotate()}>
        {busy ? 'Rotating…' : 'Rotate vault key'}
      </Button>
      {msg ? <p className="text-xs text-emerald-600">{msg}</p> : null}
    </div>
  );
}

function InviteForm({ orgId }: { orgId: string }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin' | 'viewer'>('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const submitting = useRef(false);

  const invite = async () => {
    if (submitting.current) return; // guard against double-submit (creates two invites)
    submitting.current = true;
    setBusy(true);
    setError(null);
    setInviteUrl(null);
    setCopied(false);
    try {
      const r = await api.orgInvite(orgId, role, email.trim() || undefined);
      setInviteUrl(r.url);
      setEmail('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not create invite.');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const copyInvite = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the link is shown for manual copy */
    }
  };

  return (
    <div className="space-y-2 border-t pt-4">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void invite();
        }}
      >
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="teammate@example.com (optional)"
          className="max-w-xs"
        />
        <select
          className={SELECT_CLS}
          value={role}
          onChange={(e) => setRole(e.target.value as 'member' | 'admin' | 'viewer')}
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
          <option value="viewer">Viewer</option>
        </select>
        <Button type="submit" size="sm" loading={busy}>
          Invite
        </Button>
      </form>

      {error ? <Alert>{error}</Alert> : null}
      {inviteUrl ? (
        <Alert tone="info">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span>Invite created. Share this link:</span>
              <Button size="sm" variant="outline" onClick={() => void copyInvite()}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <div className="break-all font-mono text-xs select-all">{inviteUrl}</div>
          </div>
        </Alert>
      ) : null}
    </div>
  );
}
