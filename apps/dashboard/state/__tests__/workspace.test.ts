/**
 * W1 (isolamento por projeto) — testes puros do useWorkspaceStore.
 * Sem Monaco/sqlite/DOM: a persistência se auto-desliga quando `window` é
 * undefined (node), então testamos a isolação em-memória + o drop do setProject.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkspaceStore, type OpenFile } from '../workspace.js';

const reset = () =>
  useWorkspaceStore.setState({ openFiles: [], activeFilePath: null, activeProjectId: null });

const file = (projectId: number, path: string): OpenFile => ({
  kind: 'file',
  projectId,
  path,
  content: null,
  dirty: false,
  lastModified: null,
});

describe('useWorkspaceStore — isolamento por projeto (P1)', () => {
  beforeEach(reset);

  it('openFile carimba activeProjectId e dedup por (path, projectId)', () => {
    const s = useWorkspaceStore.getState();
    s.openFile(file(1, 'a.ts'));
    expect(useWorkspaceStore.getState().activeProjectId).toBe(1);
    s.openFile(file(1, 'a.ts')); // dedup
    expect(useWorkspaceStore.getState().openFiles).toHaveLength(1);
    s.openFile(file(7, 'a.ts')); // mesmo path, projeto diferente → nova aba
    expect(useWorkspaceStore.getState().openFiles).toHaveLength(2);
    expect(useWorkspaceStore.getState().activeProjectId).toBe(7);
  });

  it('setProject dropa as abas do projeto que sai e atualiza activeProjectId', () => {
    const s = useWorkspaceStore.getState();
    s.setProject(1);
    s.openFile(file(1, 'a.ts'));
    expect(useWorkspaceStore.getState().openFiles).toHaveLength(1);
    s.setProject(2);
    expect(useWorkspaceStore.getState().activeProjectId).toBe(2);
    expect(useWorkspaceStore.getState().openFiles).toHaveLength(0); // abas de 1 saíram
  });

  it('setProject(sameId) é no-op (não recria o array)', () => {
    const s = useWorkspaceStore.getState();
    s.setProject(1);
    const ref = useWorkspaceStore.getState().openFiles;
    s.setProject(1);
    expect(useWorkspaceStore.getState().openFiles).toBe(ref);
  });

  it('regressão: closeFile(B, path) não fecha a aba homônima de A', () => {
    useWorkspaceStore.setState({
      activeProjectId: 1,
      openFiles: [file(1, 'src/index.ts'), file(2, 'src/index.ts')],
      activeFilePath: 'src/index.ts',
    });
    useWorkspaceStore.getState().closeFile(2, 'src/index.ts');
    const left = useWorkspaceStore.getState().openFiles;
    expect(left).toHaveLength(1);
    expect(left[0].projectId).toBe(1);
  });

  it('setContent muta só a tupla (projectId, path) casada', () => {
    useWorkspaceStore.setState({
      activeProjectId: 1,
      openFiles: [file(1, 'x.ts'), file(2, 'x.ts')],
      activeFilePath: 'x.ts',
    });
    useWorkspaceStore.getState().setContent(2, 'x.ts', 'novo');
    const [a, b] = useWorkspaceStore.getState().openFiles as OpenFile[];
    expect(a.content).toBeNull(); // projeto 1 intacto
    expect(b.content).toBe('novo'); // projeto 2 mudou
    expect(b.dirty).toBe(true);
  });

  it('markExternallyChanged / applyExternalContent respeitam (projectId, path)', () => {
    useWorkspaceStore.setState({
      activeProjectId: 1,
      openFiles: [file(1, 'y.ts'), file(2, 'y.ts')],
      activeFilePath: 'y.ts',
    });
    useWorkspaceStore.getState().markExternallyChanged(2, 'y.ts');
    let files = useWorkspaceStore.getState().openFiles as OpenFile[];
    expect(files[0].externallyChanged).toBeFalsy();
    expect(files[1].externallyChanged).toBe(true);

    useWorkspaceStore.getState().applyExternalContent(1, 'y.ts', 'fromDisk', 'mtime');
    files = useWorkspaceStore.getState().openFiles as OpenFile[];
    expect(files[0].content).toBe('fromDisk');
    expect(files[0].dirty).toBe(false);
    expect(files[1].content).toBeNull(); // projeto 2 intacto
  });

  it('closeOthers mantém só o sobrevivente do projeto pedido', () => {
    useWorkspaceStore.setState({
      activeProjectId: 1,
      openFiles: [file(1, 'a.ts'), file(1, 'b.ts'), file(1, 'c.ts')],
      activeFilePath: 'b.ts',
    });
    useWorkspaceStore.getState().closeOthers(1, 'b.ts');
    const left = useWorkspaceStore.getState().openFiles;
    expect(left).toHaveLength(1);
    expect(left[0].path).toBe('b.ts');
  });
});
