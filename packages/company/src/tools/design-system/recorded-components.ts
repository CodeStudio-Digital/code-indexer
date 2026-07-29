/**
 * Componentes "registrados" de uma sessão DS = draft aberto ∪ última versão
 * publicada (mesma semântica do ds_list_components). Helper compartilhado
 * por ds_get_pipeline / ds_submit_stage / audit.
 */
import type { DesignSystemStore } from '@mcp/store/design-system-store.js';
import type { SessionId } from '@mcp/session-storage';

export interface RecordedComponent {
  name: string;
  kind: string;
  props_schema_json: string | null;
}

export async function collectRecordedComponents(
  store: DesignSystemStore,
  sessionId: SessionId,
): Promise<RecordedComponent[]> {
  const byName = new Map<string, RecordedComponent>();
  const published = await store.getLatestPublishedVersion(sessionId);
  if (published) {
    for (const c of await store.listComponents(published.id)) {
      byName.set(c.name.toLowerCase(), { name: c.name, kind: c.kind, props_schema_json: c.props_schema_json });
    }
  }
  const draft = await store.getLatestVersionAny(sessionId);
  if (draft && (draft.status === 'draft' || draft.status === 'building')) {
    for (const c of await store.listComponents(draft.id)) {
      byName.set(c.name.toLowerCase(), { name: c.name, kind: c.kind, props_schema_json: c.props_schema_json });
    }
  }
  return [...byName.values()];
}
