/**
 * chmod / chown for a remote file or folder.
 *
 * The rwx grid and the octal box are two views of ONE number, kept in sync both
 * ways — people who think in `755` and people who think in checkboxes both get
 * their model, and neither can drift from what will actually be sent.
 *
 * Owner/group are free-text with a datalist of the host's real accounts,
 * because the server may know names this device has never seen. chown almost
 * always requires root, so its failure is expected and reported verbatim rather
 * than dressed up.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, ShieldCheck } from 'lucide-react';
import type { SftpIdNames } from '@mcp/api-bus';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog.js';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { fmtMode, type FsItem } from './fs-adapter.js';

/** The nine rwx bits, in the order chmod prints them. */
const CLASSES = ['user', 'group', 'other'] as const;
const BITS = [
  { key: 'r', value: 4 },
  { key: 'w', value: 2 },
  { key: 'x', value: 1 },
] as const;

export interface PermissionsSubmit {
  /** Low 12 bits, or null when the user didn't change them. */
  mode: number | null;
  /** Resolved numeric ids, or null when unchanged / unresolvable. */
  uid: number | null;
  gid: number | null;
  recursive: boolean;
}

interface Props {
  open: boolean;
  item: FsItem | null;
  idNames: SftpIdNames;
  busy: boolean;
  error: string | null;
  onOpenChange: (v: boolean) => void;
  onSubmit: (v: PermissionsSubmit) => void;
}

/** name → id, inverted from the id → name maps the host gave us. */
function invert(map: Record<string, string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, name] of Object.entries(map)) out.set(name, Number(id));
  return out;
}

export function PermissionsDialog({ open, item, idNames, busy, error, onOpenChange, onSubmit }: Props) {
  const { t } = useTranslation('ssh');
  const [mode, setMode] = useState(0);
  const [octal, setOctal] = useState('');
  const [owner, setOwner] = useState('');
  const [group, setGroup] = useState('');
  const [recursive, setRecursive] = useState(false);

  const usersByName = useMemo(() => invert(idNames.users), [idNames.users]);
  const groupsByName = useMemo(() => invert(idNames.groups), [idNames.groups]);

  // Re-seed from the item every time the dialog opens, so a previous edit can
  // never leak onto a different file.
  useEffect(() => {
    if (!open || !item) return;
    const initial = item.mode & 0o7777;
    setMode(initial);
    setOctal(initial.toString(8).padStart(3, '0'));
    setOwner(item.owner ?? (item.uid != null ? String(item.uid) : ''));
    setGroup(item.group ?? (item.gid != null ? String(item.gid) : ''));
    setRecursive(false);
  }, [open, item]);

  const setBoth = (next: number): void => {
    setMode(next);
    setOctal(next.toString(8).padStart(3, '0'));
  };

  const toggleBit = (classIndex: number, bit: number): void => {
    const shift = (2 - classIndex) * 3;
    setBoth(mode ^ (bit << shift));
  };

  const onOctalChange = (raw: string): void => {
    setOctal(raw);
    // Only adopt a COMPLETE, valid octal so the grid doesn't flicker through
    // nonsense while the user is still typing.
    if (/^[0-7]{3,4}$/.test(raw)) setMode(parseInt(raw, 8));
  };

  if (!item) return null;

  const initialMode = item.mode & 0o7777;
  const initialOwner = item.owner ?? (item.uid != null ? String(item.uid) : '');
  const initialGroup = item.group ?? (item.gid != null ? String(item.gid) : '');
  const ownerChanged = owner.trim() !== initialOwner;
  const groupChanged = group.trim() !== initialGroup;

  /** Accept either a known account name or a raw numeric id. */
  const resolveId = (raw: string, byName: Map<string, number>): number | null => {
    const v = raw.trim();
    if (!v) return null;
    const named = byName.get(v);
    if (named != null) return named;
    return /^\d+$/.test(v) ? Number(v) : null;
  };

  const uid = ownerChanged ? resolveId(owner, usersByName) : null;
  const gid = groupChanged ? resolveId(group, groupsByName) : null;
  const ownerInvalid = ownerChanged && uid == null;
  const groupInvalid = groupChanged && gid == null;
  const modeChanged = mode !== initialMode;
  const nothingToDo = !modeChanged && !ownerChanged && !groupChanged;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" /> {t('sftp.permissionsTitle')}
          </DialogTitle>
        </DialogHeader>

        <p className="truncate font-mono text-[11px] text-muted-foreground" title={item.path}>{item.path}</p>

        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="text-left font-medium" />
              {BITS.map((b) => <th key={b.key} className="font-medium">{t(`sftp.bit.${b.key}`)}</th>)}
            </tr>
          </thead>
          <tbody>
            {CLASSES.map((cls, ci) => (
              <tr key={cls}>
                <td className="py-0.5 text-muted-foreground">{t(`sftp.class.${cls}`)}</td>
                {BITS.map((b) => {
                  const shift = (2 - ci) * 3;
                  const on = (mode & (b.value << shift)) !== 0;
                  return (
                    <td key={b.key} className="text-center">
                      <input
                        type="checkbox"
                        checked={on}
                        aria-label={`${t(`sftp.class.${cls}`)} ${t(`sftp.bit.${b.key}`)}`}
                        onChange={() => toggleBit(ci, b.value)}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>

        <div className="flex items-center gap-2">
          <span className="w-16 text-[11px] text-muted-foreground">{t('sftp.octal')}</span>
          <Input value={octal} onChange={(e) => onOctalChange(e.target.value)} className="h-7 w-24 font-mono text-xs" />
          <span className="font-mono text-[11px] text-muted-foreground">{fmtMode(mode, item.type)}</span>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="w-16 text-[11px] text-muted-foreground">{t('sftp.columns.owner')}</span>
            <Input list="sftp-users" value={owner} onChange={(e) => setOwner(e.target.value)} className="h-7 flex-1 text-xs" />
          </div>
          <div className="flex items-center gap-2">
            <span className="w-16 text-[11px] text-muted-foreground">{t('sftp.columns.group')}</span>
            <Input list="sftp-groups" value={group} onChange={(e) => setGroup(e.target.value)} className="h-7 flex-1 text-xs" />
          </div>
          <datalist id="sftp-users">
            {Object.values(idNames.users).map((n) => <option key={n} value={n} />)}
          </datalist>
          <datalist id="sftp-groups">
            {Object.values(idNames.groups).map((n) => <option key={n} value={n} />)}
          </datalist>
          {(ownerInvalid || groupInvalid) && (
            <p className="text-[11px] text-destructive">{t('sftp.unknownAccount')}</p>
          )}
          <p className="text-[10px] text-muted-foreground">{t('sftp.chownHint')}</p>
        </div>

        {item.type === 'dir' && (
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} />
            {t('sftp.applyRecursively')}
          </label>
        )}

        {error && <p className="text-[11px] text-destructive">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>{t('dialog.cancel')}</Button>
          <Button
            size="sm"
            disabled={busy || nothingToDo || ownerInvalid || groupInvalid}
            onClick={() => onSubmit({ mode: modeChanged ? mode : null, uid, gid, recursive })}
          >
            {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            {t('sftp.apply')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
