/**
 * Add / edit a saved database connection — a tabbed, DataGrip-style dialog:
 *   General  · engine, fields-or-URL connection, host/port/user/password/db
 *   Schemas  · default schema to expand first
 *   SSL      · SSL mode + CA / client cert / client key (PEM)
 *   Advanced · connect timeout, application name
 *
 * Secrets are encrypted device-bound via `@mcp/secret-box` before they reach the
 * store. In URL mode the connection string carries the password, so the WHOLE
 * URL is what gets encrypted (the server only ever persists ciphertext).
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../../components/ui/dialog.js';
import { Input } from '../../../components/ui/input.js';
import { Button } from '../../../components/ui/button.js';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../../components/ui/tabs.js';
import { toast } from '../../../components/ui/prompt-dialog.js';
import { decryptSecret } from '@mcp/secret-box';
import { AVAILABLE_ENGINES, engineMeta } from '../engines.js';
import { DriverInstallGate } from './DriverInstallGate.js';
import * as api from '../api.js';
import type { DbConnection, DbConnectSpec, DbEngine, DbSslMode } from '../types.js';

const SSL_MODES: DbSslMode[] = ['disable', 'require', 'verify-ca', 'verify-full'];

interface FormState {
  label: string;
  engine: DbEngine;
  connType: 'default' | 'url';
  host: string;
  port: string;
  username: string;
  password: string;
  database: string;
  file_path: string;
  url: string;
  ssl_mode: DbSslMode;
  sslCa: string;
  sslCert: string;
  sslKey: string;
  defaultSchema: string;
  connectTimeoutSec: string;
  applicationName: string;
  sshHostKey: string;
  is_read_only: boolean;
  color: string;
  group: string;
}

const COLORS = ['', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899'];

function initialForm(existing: DbConnection | null): FormState {
  let opts: Record<string, unknown> = {};
  let tunnel: { hostKey?: string } = {};
  if (existing) {
    try {
      opts = JSON.parse(existing.options_json || '{}') as Record<string, unknown>;
    } catch {
      opts = {};
    }
    try {
      tunnel = existing.ssh_tunnel_json ? JSON.parse(existing.ssh_tunnel_json) as { hostKey?: string } : {};
    } catch {
      tunnel = {};
    }
  }
  return {
    label: existing?.label ?? '',
    engine: existing?.engine ?? 'postgres',
    connType: opts.urlMode === true ? 'url' : 'default',
    host: existing?.host ?? '',
    port: existing?.port != null ? String(existing.port) : '',
    username: existing?.username ?? '',
    password: '',
    database: existing?.database_name ?? '',
    file_path: existing?.file_path ?? '',
    url: '',
    ssl_mode: existing?.ssl_mode ?? 'disable',
    sslCa: '',
    sslCert: '',
    sslKey: '',
    defaultSchema: typeof opts.defaultSchema === 'string' ? opts.defaultSchema : '',
    connectTimeoutSec: typeof opts.connectTimeoutMs === 'number' ? String(opts.connectTimeoutMs / 1000) : '',
    applicationName: typeof opts.applicationName === 'string' ? opts.applicationName : '',
    sshHostKey: tunnel.hostKey ?? (existing?.ssh_tunnel_host_id != null ? String(existing.ssh_tunnel_host_id) : ''),
    is_read_only: existing?.is_read_only === 1,
    color: existing?.color ?? '',
    group: existing?.group_name ?? '',
  };
}

export function ConnectionDialog({
  open,
  projectId,
  existing,
  onClose,
  onSaved,
}: {
  open: boolean;
  projectId: number;
  existing: DbConnection | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation('dbClient');
  const [form, setForm] = useState<FormState>(() => initialForm(existing));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [sshHosts, setSshHosts] = useState<Array<{ key: string; host: { id: number; label: string; hostname: string } }>>([]);
  const meta = useMemo(() => engineMeta(form.engine), [form.engine]);
  const usesFile = !!meta?.usesFile;
  const isUrl = !usesFile && form.connType === 'url';
  const existingIsUrl = existing ? api.isUrlMode(existing) : false;
  const canKeepConnectionSecret = !!existing && existingIsUrl === isUrl;
  const hasConnectionTarget = usesFile
    ? !!form.file_path.trim()
    : !isUrl || !!form.url.trim() || (canKeepConnectionSecret && !!existing?.enc_password);

  // The dialog stays mounted between opens. Rehydrate it for New/Edit instead
  // of leaking the previous connection's fields into the next one.
  useEffect(() => {
    if (!open) return;
    setForm(initialForm(existing));
    void api.listDbTunnelHosts(projectId).then(setSshHosts).catch(() => setSshHosts([]));
  }, [open, existing, projectId]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  function onEngine(engine: DbEngine): void {
    const m = engineMeta(engine);
    setForm((f) => ({ ...f, engine, port: m?.defaultPort != null ? String(m.defaultPort) : f.port }));
  }

  /** A secret from the form, falling back to the saved (decrypted) one while editing. */
  async function keptSecret(formValue: string, encValue: string | null | undefined): Promise<string | undefined> {
    if (formValue) return formValue;
    if (existing && encValue) return decryptSecret(encValue);
    return undefined;
  }

  function buildOptions(): Record<string, unknown> {
    const o: Record<string, unknown> = {};
    if (isUrl) o.urlMode = true;
    if (!usesFile && form.defaultSchema.trim()) o.defaultSchema = form.defaultSchema.trim();
    const secs = Number(form.connectTimeoutSec);
    if (form.connectTimeoutSec.trim() && Number.isFinite(secs) && secs > 0) o.connectTimeoutMs = Math.round(secs * 1000);
    if (form.applicationName.trim()) o.applicationName = form.applicationName.trim();
    return o;
  }

  async function buildSpec(): Promise<DbConnectSpec> {
    const ssl =
      !usesFile && form.ssl_mode !== 'disable'
        ? {
            mode: form.ssl_mode,
            ca: (await keptSecret(form.sslCa, existing?.enc_ssl_ca)) || undefined,
            cert: (await keptSecret(form.sslCert, existing?.enc_ssl_cert)) || undefined,
            key: (await keptSecret(form.sslKey, existing?.enc_ssl_key)) || undefined,
          }
        : undefined;
    const options = buildOptions();
    const sshTunnel = !usesFile && !isUrl && form.sshHostKey && form.host && form.port
      ? await api.resolveSshTunnel(projectId, form.sshHostKey, form.host, Number(form.port))
      : undefined;
    const base = {
      connectionId: existing ? String(existing.id) : `draft:${form.label || 'new'}`,
      engine: form.engine,
      ssl,
      options: Object.keys(options).length ? options : undefined,
      readOnly: form.is_read_only,
      sshTunnel,
    };
    if (usesFile) {
      return { ...base, filePath: form.file_path || undefined };
    }
    if (isUrl) {
      return {
        ...base,
        connectionString: (await keptSecret(form.url, canKeepConnectionSecret ? existing?.enc_password : undefined)) || undefined,
      };
    }
    return {
      ...base,
      host: form.host || undefined,
      port: form.port ? Number(form.port) : undefined,
      username: form.username || undefined,
      password: (await keptSecret(form.password, canKeepConnectionSecret ? existing?.enc_password : undefined)) || undefined,
      database: form.database.trim() || undefined,
    };
  }

  async function onTest(): Promise<void> {
    setTesting(true);
    try {
      const res = await api.testConnection(await buildSpec());
      if (res.ok) toast.success(t('dialog.testOk'), { description: res.serverVersion });
      else toast.error(t('dialog.testFail'), { description: res.reason });
    } catch (e) {
      toast.error(t('dialog.testFail'), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  }

  async function onSave(): Promise<void> {
    if (!form.label.trim()) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        label: form.label.trim(),
        engine: form.engine,
        host: usesFile || isUrl ? null : form.host || null,
        port: usesFile || isUrl || !form.port ? null : Number(form.port),
        username: usesFile || isUrl ? null : form.username || null,
        database_name: isUrl ? null : form.database.trim() || null,
        file_path: usesFile ? form.file_path || null : null,
        ssl_mode: usesFile ? null : form.ssl_mode,
        is_read_only: form.is_read_only,
        color: form.color || null,
        group_name: form.group.trim() || null,
        options: buildOptions(),
        ssh_tunnel_host_id: !usesFile && !isUrl && form.sshHostKey
          ? (sshHosts.find((item) => item.key === form.sshHostKey)?.host.id ?? (Number(form.sshHostKey) || null))
          : null,
        ssh_tunnel_json: !usesFile && !isUrl && form.sshHostKey
          ? JSON.stringify({ hostKey: form.sshHostKey, remoteHost: form.host, remotePort: Number(form.port) })
          : null,
      };
      // Encrypted secret blob: URL (carries the password) or the password itself.
      // Never reinterpret a saved URL as a password (or vice versa) after the
      // user switches modes; SQLite carries no connection secret at all.
      if (usesFile) {
        if (existing) body.enc_password = null;
      } else if (isUrl) {
        if (form.url) body.enc_password = await api.encryptSecretValue(form.url);
      } else if (form.password) {
        body.enc_password = await api.encryptSecretValue(form.password);
      } else if (existing && existingIsUrl) {
        body.enc_password = null;
      }
      // SSL certs (encrypted at rest; re-encrypt only what the user typed).
      if (!usesFile && form.ssl_mode !== 'disable') {
        if (form.sslCa) body.enc_ssl_ca = await api.encryptSecretValue(form.sslCa);
        if (form.sslCert) body.enc_ssl_cert = await api.encryptSecretValue(form.sslCert);
        if (form.sslKey) body.enc_ssl_key = await api.encryptSecretValue(form.sslKey);
      } else if (existing) {
        // SSL turned off (or switched to a file DB) — clear any stored cert blobs
        // so they don't linger encrypted in metadata after the user disabled SSL.
        body.enc_ssl_ca = null;
        body.enc_ssl_cert = null;
        body.enc_ssl_key = null;
      }
      if (existing) await api.patchConnection(projectId, existing.id, body);
      else await api.createConnection(projectId, body);
      onSaved();
      onClose();
    } catch (e) {
      toast.error(t('dialog.testFail'), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{existing ? t('dialog.titleEdit') : t('dialog.titleNew')}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-3 text-xs">
          {/* Name + engine are always visible (above the tabs). */}
          <Field label={t('dialog.name')}>
            <Input value={form.label} onChange={(e) => set('label', e.target.value)} placeholder={t('dialog.namePlaceholder')} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('dialog.engine')}>
              <select className="h-8 w-full rounded-md border bg-background px-2" value={form.engine} onChange={(e) => onEngine(e.target.value as DbEngine)}>
                {AVAILABLE_ENGINES.map((eng) => (
                  <option key={eng.id} value={eng.id}>
                    {eng.label}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex items-end pb-1.5">
              {!meta?.lazyDriver && (
                <span className="flex items-center gap-1 text-[11px] text-emerald-500">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  {t('dialog.driverBundled')}
                </span>
              )}
            </div>
          </div>

          {meta?.lazyDriver && <DriverInstallGate engine={form.engine} />}

          {usesFile ? (
            <Field label={t('dialog.filePath')}>
              <Input value={form.file_path} onChange={(e) => set('file_path', e.target.value)} placeholder={t('dialog.filePlaceholder')} />
            </Field>
          ) : (
            <Tabs defaultValue="general">
              <TabsList className="h-8">
                <TabsTrigger value="general" className="text-xs">{t('dialog.tabGeneral')}</TabsTrigger>
                <TabsTrigger value="schemas" className="text-xs">{t('dialog.tabSchemas')}</TabsTrigger>
                <TabsTrigger value="ssl" className="text-xs">{t('dialog.tabSsl')}</TabsTrigger>
                <TabsTrigger value="advanced" className="text-xs">{t('dialog.tabAdvanced')}</TabsTrigger>
              </TabsList>

              <TabsContent value="general" className="mt-3 grid gap-3">
                <Field label={t('dialog.connType')}>
                  <div className="flex gap-1">
                    {(['default', 'url'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => set('connType', m)}
                        className={`h-7 flex-1 rounded border text-xs ${form.connType === m ? 'border-primary bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/50'}`}
                      >
                        {m === 'default' ? t('dialog.connDefault') : t('dialog.connUrl')}
                      </button>
                    ))}
                  </div>
                </Field>

                {isUrl ? (
                  <Field label={t('dialog.url')}>
                    <Input value={form.url} onChange={(e) => set('url', e.target.value)} placeholder={existing ? t('dialog.urlKept') : t('dialog.urlPlaceholder')} />
                  </Field>
                ) : (
                  <>
                    <div className="grid grid-cols-[1fr_90px] gap-2">
                      <Field label={t('dialog.host')}>
                        <Input value={form.host} onChange={(e) => set('host', e.target.value)} placeholder={'localhost'} />
                      </Field>
                      <Field label={t('dialog.port')}>
                        <Input value={form.port} onChange={(e) => set('port', e.target.value)} inputMode="numeric" />
                      </Field>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label={t('dialog.user')}>
                        <Input value={form.username} onChange={(e) => set('username', e.target.value)} />
                      </Field>
                      <Field label={t('dialog.password')}>
                        <Input type="password" value={form.password} onChange={(e) => set('password', e.target.value)} placeholder={existing ? t('dialog.passwordKept') : ''} />
                      </Field>
                    </div>
                    <Field label={t('dialog.database')}>
                      <Input value={form.database} onChange={(e) => set('database', e.target.value)} />
                    </Field>
                    <p className="text-[11px] text-muted-foreground">{t('dialog.databaseHint')}</p>
                  </>
                )}

                <label className="flex items-center gap-2 text-muted-foreground">
                  <input type="checkbox" checked={form.is_read_only} onChange={(e) => set('is_read_only', e.target.checked)} />
                  {t('dialog.readOnly')}
                </label>

                <div className="grid grid-cols-2 gap-2">
                  <Field label={t('dialog.group')}>
                    <Input value={form.group} onChange={(e) => set('group', e.target.value)} placeholder={t('dialog.groupPlaceholder')} />
                  </Field>
                  <Field label={t('dialog.color')}>
                    <div className="flex h-8 items-center gap-1.5">
                      {COLORS.map((c) => (
                        <button
                          key={c || 'none'}
                          type="button"
                          onClick={() => set('color', c)}
                          className={`h-4 w-4 rounded-full border ${form.color === c ? 'ring-2 ring-foreground ring-offset-1 ring-offset-background' : ''} ${c ? '' : 'bg-transparent'}`}
                          style={c ? { backgroundColor: c } : undefined}
                          title={c || t('dialog.colorNone')}
                          aria-label={c || t('dialog.colorNone')}
                        />
                      ))}
                    </div>
                  </Field>
                </div>
              </TabsContent>

              <TabsContent value="schemas" className="mt-3 grid gap-2">
                <Field label={t('dialog.defaultSchema')}>
                  <Input
                    value={form.defaultSchema}
                    onChange={(e) => set('defaultSchema', e.target.value)}
                    placeholder={form.engine === 'mssql' ? 'dbo' : 'public'}
                  />
                </Field>
                <p className="text-[11px] text-muted-foreground">{t('dialog.defaultSchemaHint')}</p>
              </TabsContent>

              <TabsContent value="ssl" className="mt-3 grid gap-3">
                <Field label={t('dialog.ssl')}>
                  <select className="h-8 w-full rounded-md border bg-background px-2" value={form.ssl_mode} onChange={(e) => set('ssl_mode', e.target.value as DbSslMode)}>
                    {SSL_MODES.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </Field>
                {form.ssl_mode !== 'disable' && (
                  <>
                    <CertField label={t('dialog.sslCa')} value={form.sslCa} onChange={(v) => set('sslCa', v)} kept={!!existing && !!existing.enc_ssl_ca} keptLabel={t('dialog.sslKept')} />
                    <CertField label={t('dialog.sslCert')} value={form.sslCert} onChange={(v) => set('sslCert', v)} kept={!!existing && !!existing.enc_ssl_cert} keptLabel={t('dialog.sslKept')} />
                    <CertField label={t('dialog.sslKey')} value={form.sslKey} onChange={(v) => set('sslKey', v)} kept={!!existing && !!existing.enc_ssl_key} keptLabel={t('dialog.sslKept')} />
                  </>
                )}
              </TabsContent>

              <TabsContent value="advanced" className="mt-3 grid gap-3">
                <div className="grid grid-cols-2 gap-2">
                  <Field label={t('dialog.connectTimeout')}>
                    <Input value={form.connectTimeoutSec} onChange={(e) => set('connectTimeoutSec', e.target.value)} inputMode="numeric" />
                  </Field>
                  <Field label={t('dialog.applicationName')}>
                    <Input value={form.applicationName} onChange={(e) => set('applicationName', e.target.value)} />
                  </Field>
                </div>
                {!isUrl && (
                  <Field label={t('dialog.sshTunnel')}>
                    <select className="h-8 w-full rounded-md border bg-background px-2" value={form.sshHostKey} onChange={(event) => set('sshHostKey', event.target.value)}>
                      <option value="">{t('dialog.sshNone')}</option>
                      {sshHosts.map((item) => <option key={item.key} value={item.key}>{item.host.label} · {item.host.hostname}</option>)}
                    </select>
                  </Field>
                )}
                <p className="text-[11px] text-muted-foreground">{t('dialog.sshHint')}</p>
              </TabsContent>
            </Tabs>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onTest} disabled={testing || !hasConnectionTarget}>
            {testing ? t('dialog.testing') : t('dialog.test')}
          </Button>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('dialog.cancel')}
          </Button>
          <Button size="sm" onClick={onSave} disabled={saving || !form.label.trim() || !hasConnectionTarget}>
            {t('dialog.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function CertField({
  label,
  value,
  onChange,
  kept,
  keptLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  kept: boolean;
  keptLabel: string;
}) {
  return (
    <label className="grid gap-1">
      <span className="text-muted-foreground">{label}</span>
      <textarea
        className="h-14 resize-none rounded-md border bg-background px-2 py-1 font-mono text-[11px] outline-none"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={kept ? keptLabel : '-----BEGIN…'}
        spellCheck={false}
      />
    </label>
  );
}
