/**
 * Redis key viewer/editor.
 *  - string: editable value (SET) + TTL.
 *  - hash/list/set/zset: field-by-field editor (add / edit / delete elements via
 *    hset·hdel / lset·rpush·lrem / sadd·srem / zadd·zrem). Each element op applies
 *    immediately (Redis has no transactional element edit) and reloads the value.
 *  - any key: rename (RENAME) + TTL + delete.
 * "New" mode creates a string key.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Trash2, Plus, Check, Pencil } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../../components/ui/dialog.js';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { confirm, toast } from '../../../components/ui/prompt-dialog.js';
import * as api from '../api.js';
import type { DbCommand } from '../types.js';

type KvOp = DbCommand['op'];

/** Parse the typed value the `get` op returns into editable elements. */
function elementsOf(type: string, value: unknown): Array<{ k: string; v: string }> {
  if (type === 'hash' && value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).map(([k, v]) => ({ k, v: String(v) }));
  }
  if (type === 'list' && Array.isArray(value)) {
    return value.map((v, i) => ({ k: String(i), v: String(v) }));
  }
  if (type === 'set' && Array.isArray(value)) {
    return value.map((v) => ({ k: String(v), v: String(v) }));
  }
  if (type === 'zset' && Array.isArray(value)) {
    // WITHSCORES → flat [member, score, member, score, …]
    const out: Array<{ k: string; v: string }> = [];
    for (let i = 0; i < value.length; i += 2) out.push({ k: String(value[i]), v: String(value[i + 1] ?? '') });
    return out;
  }
  return [];
}

export function KeyEditor({
  connKey,
  db,
  keyName,
  onClose,
  onSaved,
}: {
  connKey: string;
  db: string;
  keyName: string | null; // null = new key
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation('dbClient');
  const isNew = keyName === null;
  const [key, setKey] = useState(keyName ?? '');
  const [type, setType] = useState<string>('string');
  const [value, setValue] = useState('');
  const [elements, setElements] = useState<Array<{ k: string; v: string }>>([]);
  const [ttl, setTtl] = useState(''); // seconds; '' = no expiry
  const [loading, setLoading] = useState(!isNew);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');
  const [partial, setPartial] = useState(!isNew);

  const load = useCallback(async () => {
    if (isNew) return;
    const res = await api.runCommand(connKey, { kind: 'keyvalue', op: 'get', payload: { db, key: keyName } });
    const row = res.rows[0] ?? {};
    setPartial(res.truncated === true);
    const ty = String(row.type ?? 'string');
    setType(ty);
    if (ty === 'string') setValue(String(row.value ?? ''));
    else setElements(elementsOf(ty, row.value));
    const ttlNum = Number(row.ttl ?? -1);
    setTtl(ttlNum >= 0 ? String(ttlNum) : '');
  }, [connKey, db, keyName, isNew]);

  useEffect(() => {
    if (isNew) return;
    let live = true;
    setLoading(true);
    void load()
      .catch((e) => live && toast.error(t('kv.loadError'), { description: e instanceof Error ? e.message : String(e) }))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [load, isNew, t]);

  /** Fire one element op then reload the value. */
  const elementOp = useCallback(
    async (op: KvOp, payload: Record<string, unknown>) => {
      if (partial) return;
      setBusy(true);
      try {
        await api.runCommand(connKey, { kind: 'keyvalue', op, payload: { db, key, ...payload } });
        await load();
      } catch (e) {
        toast.error(t('kv.saveError'), { description: e instanceof Error ? e.message : String(e) });
      } finally {
        setBusy(false);
      }
    },
    [connKey, db, key, load, partial, t],
  );

  const isString = isNew || type === 'string';

  /** Parse the TTL field → seconds (0 = no expiry). Returns null on a non-numeric entry. */
  function parseTtl(): number | null {
    if (!ttl.trim()) return 0;
    const n = Number(ttl);
    if (Number.isNaN(n)) { toast.error(t('kv.badTtl')); return null; }
    return n;
  }

  async function saveString(): Promise<void> {
    if (partial || !key.trim()) return;
    const ttlNum = parseTtl();
    if (ttlNum === null) return;
    setBusy(true);
    try {
      await api.runCommand(connKey, { kind: 'keyvalue', op: 'set', payload: { db, key, value, ttl: ttlNum } });
      toast.success(t('kv.saved'));
      onSaved();
    } catch (e) {
      toast.error(t('kv.saveError'), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function applyTtl(): Promise<void> {
    const ttlNum = parseTtl();
    if (ttlNum === null) return;
    setBusy(true);
    try {
      await api.runCommand(connKey, { kind: 'keyvalue', op: 'expire', payload: { db, key, ttl: ttlNum } });
      toast.success(t('kv.saved'));
    } catch (e) {
      toast.error(t('kv.saveError'), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function doRename(): Promise<void> {
    if (!newName.trim() || newName === key) return setRenaming(false);
    setBusy(true);
    try {
      await api.runCommand(connKey, { kind: 'keyvalue', op: 'rename', payload: { db, key, newKey: newName.trim() } });
      toast.success(t('kv.renamed'));
      onSaved();
    } catch (e) {
      toast.error(t('kv.saveError'), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function del(): Promise<void> {
    if (!(await confirm({ title: t('kv.deleteConfirm', { key }), tone: 'destructive' }))) return;
    setBusy(true);
    try {
      await api.runCommand(connKey, { kind: 'keyvalue', op: 'del', payload: { db, key } });
      toast.success(t('kv.deleted'));
      onSaved();
    } catch (e) {
      toast.error(t('kv.saveError'), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-mono text-sm">
            {isNew ? (
              t('kv.newTitle')
            ) : renaming ? (
              <>
                <Input value={newName} onChange={(e) => setNewName(e.target.value)} className="h-7 flex-1 font-mono" autoFocus />
                <button className="rounded p-1 hover:bg-muted" title={t('kv.rename')} onClick={() => void doRename()} disabled={busy}>
                  <Check className="h-3.5 w-3.5" />
                </button>
              </>
            ) : (
              <>
                <span className="truncate">{key}</span>
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{type}</span>
                <button className="rounded p-1 hover:bg-muted" title={t('kv.rename')} onClick={() => { setNewName(key); setRenaming(true); }}>
                  <Pencil className="h-3 w-3" />
                </button>
              </>
            )}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex h-32 items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="flex flex-col gap-2">
            {partial && <p role="status" className="text-xs text-amber-500">{t('kv.partialPreview')}</p>}
            {isNew && (
              <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder={t('kv.keyPlaceholder')} className="font-mono" />
            )}
            {isString ? (
              <textarea
                className="h-48 w-full resize-none rounded border bg-background p-2 font-mono text-xs outline-none"
                value={value}
                readOnly={partial}
                onChange={(e) => setValue(e.target.value)}
                spellCheck={false}
                placeholder={t('kv.valuePlaceholder')}
              />
            ) : (
              <ElementsEditor type={type} elements={elements} busy={busy || partial} t={t} onOp={elementOp} />
            )}
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              {t('kv.ttl')}
              <Input value={ttl} onChange={(e) => setTtl(e.target.value)} placeholder={t('kv.ttlPlaceholder')} className="h-7 w-28" />
              {!isString && (
                <Button size="sm" variant="ghost" className="h-6" onClick={() => void applyTtl()} disabled={busy}>{t('kv.applyTtl')}</Button>
              )}
            </label>
          </div>
        )}

        <DialogFooter className="gap-2">
          {!isNew && (
            <Button variant="ghost" size="sm" className="mr-auto text-red-400" onClick={() => void del()} disabled={busy}>
              <Trash2 className="mr-1.5 h-3 w-3" />
              {t('kv.delete')}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            {t('edit.cancel')}
          </Button>
          {isString && (
            <Button size="sm" onClick={() => void saveString()} disabled={busy || loading || partial || (isNew && !key.trim())}>
              {busy && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
              {t('kv.save')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Field-by-field editor for hash/list/set/zset, dispatching the right element op. */
function ElementsEditor({
  type,
  elements,
  busy,
  t,
  onOp,
}: {
  type: string;
  elements: Array<{ k: string; v: string }>;
  busy: boolean;
  t: (k: string, o?: Record<string, unknown>) => string;
  onOp: (op: KvOp, payload: Record<string, unknown>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<{ a: string; b: string }>({ a: '', b: '' });
  const [edit, setEdit] = useState<{ key: string; val: string } | null>(null);

  // Column layout per type: hash = field+value, list = index+value, set = member, zset = member+score.
  const twoCol = type === 'hash' || type === 'list' || type === 'zset';

  async function addElement(): Promise<void> {
    if (type === 'hash') { if (!draft.a) return; await onOp('hset', { field: draft.a, value: draft.b }); }
    else if (type === 'list') { await onOp('rpush', { value: draft.a }); }
    else if (type === 'set') { if (!draft.a) return; await onOp('sadd', { member: draft.a }); }
    else if (type === 'zset') { if (!draft.a) return; await onOp('zadd', { member: draft.a, score: Number(draft.b || 0) }); }
    setDraft({ a: '', b: '' });
  }

  async function saveEdit(el: { k: string; v: string }): Promise<void> {
    if (!edit) return;
    if (type === 'hash') await onOp('hset', { field: el.k, value: edit.val });
    else if (type === 'list') await onOp('lset', { index: Number(el.k), value: edit.val });
    else if (type === 'zset') await onOp('zadd', { member: el.k, score: Number(edit.val || 0) });
    setEdit(null);
  }

  async function removeElement(el: { k: string; v: string }): Promise<void> {
    if (!(await confirm({
      title: t('kv.removeElementConfirm'),
      confirmLabel: t('kv.removeElement'),
      tone: 'destructive',
    }))) return;
    if (type === 'hash') await onOp('hdel', { field: el.k });
    else if (type === 'list') await onOp('ldel', { index: Number(el.k) }); // by index, not value (dupes)
    else if (type === 'set') await onOp('srem', { member: el.v });
    else if (type === 'zset') await onOp('zrem', { member: el.k });
  }

  return (
    <div className="flex max-h-64 flex-col gap-1 overflow-auto rounded border p-1">
      {elements.length === 0 && <div className="px-1 py-2 text-center text-[11px] text-muted-foreground">{t('kv.empty')}</div>}
      {elements.map((el, i) => {
        const editable = type !== 'set'; // set members aren't edited in place (delete + add)
        // el.k is the field (hash), member (zset) or index-as-string (list) — a stable edit key.
        const isEditing = edit !== null && edit.key === el.k;
        return (
          <div key={`${el.k}:${i}`} className="flex items-center gap-1 font-mono text-xs">
            <span className="w-24 shrink-0 truncate text-muted-foreground" title={el.k}>{type === 'list' ? `[${el.k}]` : el.k}</span>
            {twoCol && (
              isEditing ? (
                <Input value={edit.val} onChange={(e) => setEdit({ key: edit.key, val: e.target.value })} className="h-6 flex-1 font-mono text-xs" autoFocus />
              ) : (
                <span className="flex-1 truncate" title={el.v}>{el.v}</span>
              )
            )}
            <div className="ml-auto flex items-center gap-0.5">
              {editable && (isEditing ? (
                <button className="rounded p-1 hover:bg-muted" title={t('kv.applyEdit')} onClick={() => void saveEdit(el)} disabled={busy}><Check className="h-3 w-3" /></button>
              ) : (
                <button className="rounded p-1 hover:bg-muted" title={t('kv.editElement')} onClick={() => setEdit({ key: el.k, val: el.v })} disabled={busy}><Pencil className="h-3 w-3" /></button>
              ))}
              <button className="rounded p-1 text-red-400 hover:bg-muted" title={t('kv.removeElement')} onClick={() => void removeElement(el)} disabled={busy}><Trash2 className="h-3 w-3" /></button>
            </div>
          </div>
        );
      })}
      <div className="mt-1 flex items-center gap-1 border-t pt-1">
        <Input
          value={draft.a}
          onChange={(e) => setDraft((d) => ({ ...d, a: e.target.value }))}
          placeholder={type === 'hash' ? t('kv.field') : type === 'zset' ? t('kv.member') : t('kv.value')}
          className="h-6 flex-1 font-mono text-xs"
        />
        {twoCol && type !== 'list' && (
          <Input
            value={draft.b}
            onChange={(e) => setDraft((d) => ({ ...d, b: e.target.value }))}
            placeholder={type === 'zset' ? t('kv.score') : t('kv.value')}
            className="h-6 flex-1 font-mono text-xs"
          />
        )}
        <Button size="sm" variant="outline" className="h-6" onClick={() => void addElement()} disabled={busy}>
          <Plus className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
