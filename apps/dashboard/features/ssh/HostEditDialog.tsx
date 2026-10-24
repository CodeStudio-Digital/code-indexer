/**
 * Saved-host editor (create / edit). Collects connection details, encrypts
 * secrets with the OS keychain (`encryptSecret`) and persists via the SSH
 * routes. A "Test" button pre-flights the DIRECT connection. Connecting for
 * real happens from the host rail (so the TOFU flow lives in one place).
 *
 * Edit mode never shows stored ciphertext: secret fields start blank and are
 * only written when the user types a new value ("leave blank to keep").
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, CheckCircle2, KeyRound, Copy, Check, AlertTriangle } from 'lucide-react';
import type { SshAuth, SshConnectSpec } from '@mcp/api-bus';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../../components/ui/dialog.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Switch } from '../../components/ui/switch.js';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../../components/ui/select.js';
import { createHost, patchHost, encryptSecret, testConnection, generateKey, sshHostKey } from './api.js';
import type { SshAuthMethod, SshHost } from './types.js';

interface HostEditDialogProps {
  projectId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present → edit mode. */
  initial?: SshHost | null;
  /** Existing hosts, for the jump-host picker (excludes self). */
  hosts: SshHost[];
  onSaved: () => void;
}

const FIELD = 'flex flex-col gap-1.5';
const LABEL = 'text-xs font-medium text-muted-foreground';
const NO_JUMP = '__none__';

export function HostEditDialog({ projectId, open, onOpenChange, initial, hosts, onSaved }: HostEditDialogProps) {
  const { t } = useTranslation('ssh');
  const editing = !!initial;

  const [label, setLabel] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [method, setMethod] = useState<SshAuthMethod>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [group, setGroup] = useState('');
  const [jumpHostId, setJumpHostId] = useState<number | null>(null);
  const [agentForwarding, setAgentForwarding] = useState(false);
  const [isShared, setIsShared] = useState(false);

  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Keygen: the generated public key (shown once so the user can add it to the
  // server's authorized_keys) + a copy affordance.
  const [genPubKey, setGenPubKey] = useState<string | null>(null);
  const [genFingerprint, setGenFingerprint] = useState('');
  const [genCopied, setGenCopied] = useState(false);
  const [genBusy, setGenBusy] = useState(false);

  // Hydrate from the host being edited (secrets stay blank — "leave blank to keep").
  useEffect(() => {
    if (!open) return;
    setError(null);
    setTested(false);
    setPassword('');
    setPrivateKey('');
    setPassphrase('');
    setGenPubKey(null);
    if (initial) {
      setLabel(initial.label);
      setHost(initial.hostname);
      setPort(String(initial.port));
      setUsername(initial.username);
      setMethod(initial.auth_method);
      setGroup(initial.group_name ?? '');
      setJumpHostId(initial.jump_host_id);
      setAgentForwarding(!!initial.agent_forwarding);
      setIsShared(!!initial.is_shared);
    } else {
      setLabel('');
      setHost('');
      setPort('22');
      setUsername('');
      setMethod('password');
      setGroup('');
      setJumpHostId(null);
      setAgentForwarding(false);
      setIsShared(false);
    }
  }, [open, initial]);

  function validate(): boolean {
    if (!host.trim() || !username.trim()) {
      setError(t('dialog.required'));
      return false;
    }
    return true;
  }

  /** Inline plaintext spec for the Test button (direct, no jump). */
  function draftSpec(): SshConnectSpec {
    const auth: SshAuth =
      method === 'password'
        ? { method: 'password', password }
        : method === 'privateKey'
          ? { method: 'privateKey', privateKey, passphrase: passphrase || undefined }
          : { method: 'agent' };
    return { hostId: `draft:test`, host: host.trim(), port: port ? Number(port) : 22, username: username.trim(), auth };
  }

  async function handleTest(): Promise<void> {
    setError(null);
    setTested(false);
    if (!validate()) return;
    setTesting(true);
    try {
      const res = await testConnection(draftSpec());
      if (res.ok) setTested(true);
      else setError(t('error.connectFailed', { reason: res.reason }));
    } catch (e) {
      setError(t('error.connectFailed', { reason: e instanceof Error ? e.message : String(e) }));
    } finally {
      setTesting(false);
    }
  }

  /** Encrypt the secret fields the user actually typed; omit blanks (keep stored). */
  async function encSecrets(): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    if (method === 'password' && password) out.enc_password = await encryptSecret(password);
    if (method === 'privateKey') {
      if (privateKey) out.enc_private_key = await encryptSecret(privateKey);
      if (passphrase) out.enc_passphrase = await encryptSecret(passphrase);
    }
    return out;
  }

  async function handleSave(): Promise<void> {
    setError(null);
    if (!validate()) return;
    setBusy(true);
    try {
      const enc = await encSecrets();
      const body = {
        label: label.trim() || `${username.trim()}@${host.trim()}`,
        hostname: host.trim(),
        port: port ? Number(port) : 22,
        username: username.trim(),
        auth_method: method,
        group_name: group.trim() || null,
        jump_host_id: jumpHostId,
        agent_forwarding: agentForwarding,
        is_shared: isShared,
        ...enc,
      };
      if (initial) await patchHost(projectId, initial, body);
      else await createHost(projectId, body);
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleGenerateKey(): Promise<void> {
    setError(null);
    setGenBusy(true);
    try {
      const comment = username.trim() && host.trim() ? `${username.trim()}@${host.trim()}` : 'codestudio';
      const k = await generateKey({ type: 'ed25519', comment, passphrase: passphrase || undefined });
      setPrivateKey(k.privateKey);
      setGenPubKey(k.publicKey);
      setGenFingerprint(k.fingerprint);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenBusy(false);
    }
  }

  async function copyPubKey(): Promise<void> {
    if (!genPubKey) return;
    try {
      await navigator.clipboard.writeText(genPubKey);
      setGenCopied(true);
      setTimeout(() => setGenCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  // A shared host may only jump through ANOTHER shared host (a project-local jump
  // wouldn't resolve from other projects); a local host can jump through either.
  const initialKey = initial ? sshHostKey(initial) : null;
  const jumpCandidates = hosts.filter((h) => sshHostKey(h) !== initialKey && (!isShared || !!h.is_shared));
  const jumpValue = jumpHostId == null
    ? NO_JUMP
    : sshHostKey(jumpCandidates.find((h) => h.id === jumpHostId) ?? {
        id: jumpHostId,
        is_shared: isShared ? 1 : 0,
      });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? t('dialog.titleEdit') : t('dialog.titleNew')}</DialogTitle>
          <DialogDescription>{t('dialog.description')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className={FIELD}>
            <label className={LABEL}>{t('dialog.label')}</label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('dialog.labelPlaceholder')} />
          </div>

          <div className="grid grid-cols-[1fr_88px] gap-3">
            <div className={FIELD}>
              <label className={LABEL}>{t('dialog.host')}</label>
              <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder={t('dialog.hostPlaceholder')} autoFocus />
            </div>
            <div className={FIELD}>
              <label className={LABEL}>{t('dialog.port')}</label>
              <Input value={port} onChange={(e) => setPort(e.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className={FIELD}>
              <label className={LABEL}>{t('dialog.username')}</label>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={t('dialog.usernamePlaceholder')} />
            </div>
            <div className={FIELD}>
              <label className={LABEL}>{t('dialog.group')}</label>
              <Input value={group} onChange={(e) => setGroup(e.target.value)} placeholder={t('dialog.groupPlaceholder')} />
            </div>
          </div>

          <div className={FIELD}>
            <label className={LABEL}>{t('dialog.authMethod')}</label>
            <Select value={method} onValueChange={(v) => setMethod(v as SshAuthMethod)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="password">{t('dialog.authPassword')}</SelectItem>
                <SelectItem value="privateKey">{t('dialog.authPrivateKey')}</SelectItem>
                <SelectItem value="agent">{t('dialog.authAgent')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {method === 'password' && (
            <div className={FIELD}>
              <label className={LABEL}>{t('dialog.password')}</label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          )}
          {method === 'privateKey' && (
            <>
              <div className={FIELD}>
                <div className="flex items-center justify-between">
                  <label className={LABEL}>{t('dialog.privateKey')}</label>
                  <button
                    type="button"
                    onClick={() => void handleGenerateKey()}
                    disabled={genBusy}
                    className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline disabled:opacity-50"
                  >
                    {genBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <KeyRound className="h-3 w-3" />}
                    {t('dialog.generateKey')}
                  </button>
                </div>
                <Textarea value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} placeholder={t('dialog.privateKeyPlaceholder')} rows={4} className="font-mono text-xs" />
              </div>
              {genPubKey && (
                <div className="rounded-md border bg-muted/40 p-2 space-y-1.5">
                  <p className="text-[11px] text-muted-foreground">{t('dialog.publicKeyHint')}</p>
                  <div className="flex items-start gap-2">
                    <code className="flex-1 min-w-0 break-all text-[10px] font-mono select-all">{genPubKey}</code>
                    <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" title={t('vault.copy')} onClick={() => void copyPubKey()}>
                      {genCopied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                    </Button>
                  </div>
                  {genFingerprint && <p className="text-[10px] text-muted-foreground font-mono">{genFingerprint}</p>}
                </div>
              )}
              <div className={FIELD}>
                <label className={LABEL}>{t('dialog.passphrase')}</label>
                <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
              </div>
            </>
          )}
          {method === 'agent' && <p className="text-xs text-muted-foreground">{t('dialog.agentHint')}</p>}

          <div className={FIELD}>
            <label className={LABEL}>{t('dialog.jumpHost')}</label>
            <Select
              value={jumpValue}
              onValueChange={(v) => setJumpHostId(v === NO_JUMP ? null : Number(v.split(':')[1]))}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_JUMP}>{t('dialog.jumpNone')}</SelectItem>
                {jumpCandidates.map((h) => (
                  <SelectItem key={sshHostKey(h)} value={sshHostKey(h)}>{h.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{t('dialog.agentForwarding')}</span>
            <Switch checked={agentForwarding} onCheckedChange={setAgentForwarding} />
          </label>
          {agentForwarding && (
            <p className="text-[11px] text-amber-500 flex items-start gap-1 -mt-1">
              <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
              {t('dialog.agentForwardingWarning')}
            </p>
          )}

          <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{t('dialog.shareAcrossProjects')}</span>
            <Switch checked={isShared} onCheckedChange={setIsShared} />
          </label>
          {isShared && (
            <p className="text-[11px] text-amber-500 flex items-start gap-1 -mt-1">
              <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
              {t('dialog.sharedWarning')}
            </p>
          )}

          {error && <p className="text-xs text-red-500">{error}</p>}
          {tested && !error && (
            <p className="flex items-center gap-1.5 text-xs text-emerald-500">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {t('dialog.testOk')}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>{t('dialog.cancel')}</Button>
          <Button variant="outline" onClick={handleTest} disabled={testing || busy}>
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {testing ? t('dialog.testing') : t('dialog.test')}
          </Button>
          <Button onClick={handleSave} disabled={busy || testing}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {busy ? t('dialog.saving') : t('dialog.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
