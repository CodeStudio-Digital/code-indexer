/** Teams — organizations the user belongs to, with members, invites, and role
 *  management. Owners/admins can invite (emailed or link) and remove members. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Users } from 'lucide-react';
import type { OrgMemberPublic, OrgPublic, OrgRolePublic } from '@mcp/api-bus';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Spinner } from '../lib/ui.js';

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
    if (!confirm('Remove this member from the team?')) return;
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
      </CardContent>
    </Card>
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
