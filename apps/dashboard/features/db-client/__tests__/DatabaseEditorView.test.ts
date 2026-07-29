import { describe, expect, it, vi } from 'vitest';
import type { OpenDatabaseTab } from '../../../state/workspace.js';

/**
 * These tests call the components as plain functions to inspect the element
 * tree they return — no renderer, so React's hook dispatcher is null and the
 * component's `useWorkspaceStore(...)` selector throws "Invalid hook call".
 * Stub just that hook (the assertions are about keys and props, not the store)
 * and leave the rest of the module intact for anything else in the graph.
 */
vi.mock('../../../state/workspace.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useWorkspaceStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ updateDatabaseTab: () => undefined }),
}));

const { DatabaseEditorStack, DatabaseEditorView } = await import('../DatabaseEditorView.js');

function dataTab(table: string): OpenDatabaseTab {
  const id = `data:1:app:${table}`;
  return {
    kind: 'database',
    projectId: 7,
    path: `database:${id}`,
    title: table,
    workTab: {
      id,
      kind: 'data',
      title: table,
      connectionId: 1,
      connKey: '1',
      schema: 'app',
      table,
    },
    engine: 'mysql',
    suggestions: [],
  };
}

describe('DatabaseEditorView', () => {
  it('isola a instancia stateful de cada aba de tabela', () => {
    const logsTab = dataTab('api_logs');
    const clientsTab = dataTab('api_clients');

    const logsView = DatabaseEditorView({ tab: logsTab });
    const clientsView = DatabaseEditorView({ tab: clientsTab });

    // Both tabs render the same component type. Distinct keys are therefore
    // what prevents React from carrying rows/filters/edits across tables.
    expect(logsView.type).toBe(clientsView.type);
    expect(logsView.key).toBe(logsTab.path);
    expect(clientsView.key).toBe(clientsTab.path);
    expect(logsView.key).not.toBe(clientsView.key);
    expect(logsView.props.table).toBe('api_logs');
    expect(clientsView.props.table).toBe('api_clients');
  });

  it('mantem todas as abas montadas e apenas oculta as inativas', () => {
    const logsTab = dataTab('api_logs');
    const clientsTab = dataTab('api_clients');

    const stack = DatabaseEditorStack({
      tabs: [logsTab, clientsTab],
      activePath: clientsTab.path,
    });
    const surfaces = stack.props.children as Array<{
      key: string;
      props: { 'aria-hidden': boolean; className: string; children: { props: { tab: OpenDatabaseTab } } };
    }>;

    expect(surfaces).toHaveLength(2);
    expect(surfaces.map((surface) => surface.key)).toEqual([logsTab.path, clientsTab.path]);
    expect(surfaces[0].props['aria-hidden']).toBe(true);
    expect(surfaces[0].props.className).toContain('invisible');
    expect(surfaces[1].props['aria-hidden']).toBe(false);
    expect(surfaces[1].props.className).toContain('visible');
    expect(surfaces.map((surface) => surface.props.children.props.tab.workTab.table)).toEqual([
      'api_logs',
      'api_clients',
    ]);
  });
});
