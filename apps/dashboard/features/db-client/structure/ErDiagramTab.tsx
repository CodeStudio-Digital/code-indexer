/**
 * ER-diagram tab — introspects a schema's tables (columns + foreign keys) and
 * renders an entity-relationship diagram by reusing the embedded draw.io editor
 * (`DrawioFrame`). The diagram is fully editable/exportable like any draw.io
 * doc. Capped at a sane number of tables so a huge schema doesn't stall.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { DrawioFrame } from '../../chat/right-panel/diagram/DrawioFrame.js';
import * as api from '../api.js';
import { buildErXml } from './er-diagram.js';
import type { DbTableInfo } from '../types.js';

const MAX_TABLES = 40;

export function ErDiagramTab({ connectionId, schema }: { connectionId: number; schema?: string }) {
  const { t } = useTranslation('dbClient');
  const cid = String(connectionId);
  const [xml, setXml] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [capped, setCapped] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const { tables } = await api.introspect(cid, undefined, schema);
        const slice = tables.slice(0, MAX_TABLES);
        const infos: DbTableInfo[] = [];
        for (const tr of slice) {
          if (cancelled) return;
          infos.push(await api.describeTable(cid, tr.schema, tr.name));
        }
        if (!cancelled) {
          setXml(buildErXml(infos));
          setCapped(tables.length > MAX_TABLES);
        }
      } catch {
        if (!cancelled) setXml(buildErXml([]));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cid, schema]);

  if (loading) {
    return (
      <div className="grid h-full place-items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('er.building')}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {capped && <div className="border-b bg-amber-500/10 px-2 py-1 text-[11px] text-amber-400">{t('er.capped', { n: MAX_TABLES })}</div>}
      <div className="min-h-0 flex-1">
        <DrawioFrame xml={xml} title={schema} />
      </div>
    </div>
  );
}
