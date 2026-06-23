/**
 * Add / edit a saved database connection. The engine picker drives which fields
 * show (file path for SQLite, host/port/user/password for the rest). The
 * password is encrypted device-bound via `@mcp/secret-box` before it is sent to
 * the store — the server only ever persists ciphertext. "Test connection"
 * builds a live spec and pings without saving.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../../components/ui/dialog.js';
import { Input } from '../../../components/ui/input.js';
import { Button } from '../../../components/ui/button.js';
import { toast } from '../../../components/ui/prompt-dialog.js';
import { AVAILABLE_ENGINES, engineMeta } from '../engines.js';
import * as api from '../api.js';
import type { DbConnection, DbEngine, DbSslMode } from '../types.js';

const SSL_MODES: DbSslMode[] = ['disable', 'require', 'verify-ca', 'verify-full'];

interface FormState {
  label: string;
  engine: DbEngine;
  host: string;
  port: string;
  username: string;
  password: string;
  database_name: string;
  file_path: string;
  ssl_mode: DbSslMode;
  is_read_only: boolean;
}

function initialForm(existing: DbConnection | null): FormState {
  return {
    label: existing?.label ?? '',
    engine: existing?.engine ?? 'postgres',
    host: existing?.host ?? '',
    port: existing?.port != null ? String(existing.port) : '',
    username: existing?.username ?? '',
    password: '',
    database_name: existing?.database_name ?? '',
    file_path: existing?.file_path ?? '',
    ssl_mode: existing?.ssl_mode ?? 'disable',
    is_read_only: existing?.is_read_only === 1,
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
  const meta = useMemo(() => engineMeta(form.engine), [form.engine]);
  const usesFile = !!meta?.usesFile;

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  function onEngine(engine: DbEngine): void {
    const m = engineMeta(engine);
    setForm((f) => ({ ...f, engine, port: m?.defaultPort != null ? String(m.defaultPort) : f.port }));
  }

  async function buildSpec() {
    const password = form.password
      ? form.password
      : existing?.enc_password
        ? await api.resolveSpec(existing).then((s) => s.password)
        : undefined;
    return {
      connectionId: existing ? String(existing.id) : `draft:${form.label || 'new'}`,
      engine: form.engine,
      host: form.host || undefined,
      port: form.port ? Number(form.port) : undefined,
      username: form.username || undefined,
      password,
      database: form.database_name || undefined,
      filePath: form.file_path || undefined,
      ssl: form.ssl_mode !== 'disable' ? { mode: form.ssl_mode } : undefined,
      readOnly: form.is_read_only,
    };
  }

  async function onTest(): Promise<void> {
    setTesting(true);
    try {
      const spec = await buildSpec();
      const res = await api.testConnection(spec);
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
        host: usesFile ? null : form.host || null,
        port: usesFile || !form.port ? null : Number(form.port),
        username: usesFile ? null : form.username || null,
        database_name: form.database_name || null,
        file_path: usesFile ? form.file_path || null : null,
        ssl_mode: usesFile ? null : form.ssl_mode,
        is_read_only: form.is_read_only,
      };
      // Only (re)encrypt the password when the user typed one.
      if (form.password) body.enc_password = await api.encryptSecretValue(form.password);
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
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? t('dialog.titleEdit') : t('dialog.titleNew')}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-3 text-xs">
          <Field label={t('dialog.name')}>
            <Input value={form.label} onChange={(e) => set('label', e.target.value)} placeholder={t('dialog.namePlaceholder')} />
          </Field>

          <Field label={t('dialog.engine')}>
            <select
              className="h-8 w-full rounded-md border bg-background px-2"
              value={form.engine}
              onChange={(e) => onEngine(e.target.value as DbEngine)}
            >
              {AVAILABLE_ENGINES.map((eng) => (
                <option key={eng.id} value={eng.id}>
                  {eng.label}
                </option>
              ))}
            </select>
          </Field>

          {usesFile ? (
            <Field label={t('dialog.filePath')}>
              <Input value={form.file_path} onChange={(e) => set('file_path', e.target.value)} placeholder={t('dialog.filePlaceholder')} />
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
                  <Input
                    type="password"
                    value={form.password}
                    onChange={(e) => set('password', e.target.value)}
                    placeholder={existing ? t('dialog.passwordKept') : ''}
                  />
                </Field>
              </div>
              <Field label={t('dialog.ssl')}>
                <select
                  className="h-8 w-full rounded-md border bg-background px-2"
                  value={form.ssl_mode}
                  onChange={(e) => set('ssl_mode', e.target.value as DbSslMode)}
                >
                  {SSL_MODES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}

          <Field label={t('dialog.database')}>
            <Input value={form.database_name} onChange={(e) => set('database_name', e.target.value)} />
          </Field>

          <label className="flex items-center gap-2 text-muted-foreground">
            <input type="checkbox" checked={form.is_read_only} onChange={(e) => set('is_read_only', e.target.checked)} />
            {t('dialog.readOnly')}
          </label>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onTest} disabled={testing}>
            {testing ? t('dialog.testing') : t('dialog.test')}
          </Button>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('dialog.cancel')}
          </Button>
          <Button size="sm" onClick={onSave} disabled={saving || !form.label.trim()}>
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
