/**
 * SourcesPanel — multi-source controls for dataset generation:
 *   - MCP block source: which configured MCP server supplies golden shadcn
 *     blocks (persisted globally via training settings).
 *   - Doc collection: optional RAG corpus used to ground the teacher
 *     (rag_search_docs), passed per-run as `docCollection`.
 * Both degrade gracefully — leaving them unset just skips that source.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select.js';
import type { CollectionDTO, McpServerDTO } from '@mcp/api-bus';
import { getCollections, getMcpServers, getSettings, putSettings } from './api.js';

const NONE = '__none__';

export function SourcesPanel({
  docCollection, onDocCollection,
}: {
  docCollection: string;
  onDocCollection: (c: string) => void;
}) {
  const { t } = useTranslation('training');
  const [servers, setServers] = useState<McpServerDTO[]>([]);
  const [collections, setCollections] = useState<CollectionDTO[]>([]);
  const [mcpServerId, setMcpServerId] = useState('');

  useEffect(() => {
    void getMcpServers().then(setServers).catch(() => undefined);
    void getCollections().then(setCollections).catch(() => undefined);
    void getSettings().then((s) => setMcpServerId(s.mcpBlockServerId ?? '')).catch(() => undefined);
  }, []);

  const onPickServer = (v: string): void => {
    const id = v === NONE ? '' : v;
    setMcpServerId(id);
    void putSettings({ mcpBlockServerId: id || null }).catch(() => undefined);
  };

  return (
    <div className="grid grid-cols-2 gap-3">
      <label className="text-sm">
        <span className="text-muted-foreground">{t('mcpBlockSource')}</span>
        <Select value={mcpServerId || NONE} onValueChange={onPickServer}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t('mcpAuto')}</SelectItem>
            {servers.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </label>
      <label className="text-sm">
        <span className="text-muted-foreground">{t('docCollection')}</span>
        <Select value={docCollection || NONE} onValueChange={(v) => onDocCollection(v === NONE ? '' : v)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t('docCollectionNone')}</SelectItem>
            {collections.map((c) => (
              <SelectItem key={c.name} value={c.name}>{c.name} ({c.chunkCount})</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
    </div>
  );
}
