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
import { Loader2, CheckCircle2 } from 'lucide-react';
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
import { createHost, patchHost, encryptSecret, testConnection } from './api.js';
import type { SshAuthMethod, SshHost } from './types.js';

export interface HostEditDialogProps {
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

  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hydrate from the host being edited (secrets stay blank — "leave blank to keep").
  useEffect(() => {
    if (!open) return;
    setError(null);
    setTested(false);
    setPassword('');
    setPrivateKey('');
    setPassphrase('');
    if (initial) {
      setLabel(initial.label);
      setHost(initial.hostname);
      setPort(String(initial.port));
      setUsername(initial.username);
      setMethod(initial.auth_method);
      setGroup(initial.group_name ?? '');
      setJumpHostId(initial.jump_host_id);
      setAgentForwarding(!!initial.agent_forwarding);
    } else {
      setLabel('');
      setHost('');
      setPort('22');
      setUsername('');
      setMethod('password');
      setGroup('');
      setJumpHostId(null);
      setAgentForwarding(false);
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
        ...enc,
      };
      if (initial) await patchHost(projectId, initial.id, body);
      else await createHost(projectId, body);
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const jumpCandidates = hosts.filter((h) => h.id !== initial?.id);

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
                <label className={LABEL}>{t('dialog.privateKey')}</label>
                <Textarea value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} placeholder={t('dialog.privateKeyPlaceholder')} rows={4} className="font-mono text-xs" />
              </div>
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
              value={jumpHostId != null ? String(jumpHostId) : NO_JUMP}
              onValueChange={(v) => setJumpHostId(v === NO_JUMP ? null : Number(v))}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_JUMP}>{t('dialog.jumpNone')}</SelectItem>
                {jumpCandidates.map((h) => (
                  <SelectItem key={h.id} value={String(h.id)}>{h.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{t('dialog.agentForwarding')}</span>
            <Switch checked={agentForwarding} onCheckedChange={setAgentForwarding} />
          </label>

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
