import { describe, expect, it, vi } from 'vitest';
import { buildProjectContextMenuItems } from '../projectContextMenu.js';

const project = {
  id: 7,
  name: 'poa-backend',
  root_path: 'D:\\poa-monorepo\\backend',
};

const labels = {
  open: 'Abrir',
  openInNewWindow: 'Abrir em nova janela',
  openInExplorer: 'Abrir no explorador',
  copyPath: 'Copiar caminho',
  edit: 'Editar',
  copied: 'Copiado',
  index: 'Indexar',
};

describe('project context menu', () => {
  it('exposes indexing from the discoverable menu when the project needs it', () => {
    const onIndex = vi.fn();
    const items = buildProjectContextMenuItems({
      project,
      onSelect: vi.fn(),
      onEdit: vi.fn(),
      onIndex,
      labels,
    });

    const indexItem = items.find((item) => item.id === 'index');
    expect(indexItem?.label).toBe('Indexar');
    expect(indexItem?.disabled).toBe(false);
    indexItem?.onSelect?.();
    expect(onIndex).toHaveBeenCalledOnce();
  });

  it('disables the menu action while indexing and omits it when unavailable', () => {
    const activeItems = buildProjectContextMenuItems({
      project,
      onSelect: vi.fn(),
      onEdit: vi.fn(),
      onIndex: vi.fn(),
      indexing: true,
      labels: { ...labels, index: 'Indexando…' },
    });
    expect(activeItems.find((item) => item.id === 'index')).toMatchObject({
      label: 'Indexando…',
      disabled: true,
    });

    const indexedItems = buildProjectContextMenuItems({
      project,
      onSelect: vi.fn(),
      onEdit: vi.fn(),
      labels,
    });
    expect(indexedItems.some((item) => item.id === 'index')).toBe(false);
  });
});
