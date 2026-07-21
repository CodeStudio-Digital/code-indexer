/**
 * W1 (isolamento por projeto) + split de painéis — testes puros do useWorkspaceStore.
 * Sem Monaco/sqlite/DOM: a persistência se auto-desliga quando `window` é
 * undefined (node), então testamos a isolação em-memória + o drop do setProject,
 * e o layout de painéis (split/reorder/move) direto pelas ações + helpers puros.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useWorkspaceStore,
  serializeLayout,
  hydrateLayout,
  loadPersistedTabs,
  savePersistedTabs,
  __resetPaneSeqForTests,
  type OpenFile,
  type OpenSftpFile,
  type OpenDatabaseTab,
  type EditorPaneState,
} from '../workspace.js';

// Seed pane id deliberately NOT of the form `pane-N` so it never collides with
// the store's minted ids (splitEditor mints `pane-1` after the seq reset).
const SEED_PANE = 'seed-pane';

const reset = () => {
  __resetPaneSeqForTests();
  useWorkspaceStore.setState({
    openFiles: [],
    activeFilePath: null,
    activeProjectId: null,
    panes: [{ id: SEED_PANE, order: [], activePath: null }],
    splitDir: null,
    activePaneId: SEED_PANE,
  });
};

const file = (projectId: number, path: string): OpenFile => ({
  kind: 'file',
  projectId,
  path,
  content: null,
  dirty: false,
  lastModified: null,
});

const sftpFile = (projectId: number, path: string): OpenSftpFile => ({
  kind: 'sftp',
  projectId,
  path: `sftp:test-host:${path}`,
  remotePath: path,
  spec: {
    hostId: 'test-host',
    host: 'example.test',
    username: 'tester',
    auth: { method: 'agent' },
  },
  hostLabel: 'Test host',
  content: 'original',
  dirty: false,
});

/** Seed a single pane holding `paths` for `projectId` (the common single-project setup). */
const seedSingle = (projectId: number, paths: string[], active?: string) => {
  useWorkspaceStore.setState({
    activeProjectId: projectId,
    openFiles: paths.map((p) => file(projectId, p)),
    activeFilePath: active ?? paths[0] ?? null,
    panes: [{ id: SEED_PANE, order: [...paths], activePath: active ?? paths[0] ?? null }],
    splitDir: null,
    activePaneId: SEED_PANE,
  });
};

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

  it('openFile insere o path no painel ativo (uma vez)', () => {
    const s = useWorkspaceStore.getState();
    s.openFile(file(1, 'a.ts'));
    s.openFile(file(1, 'b.ts'));
    s.openFile(file(1, 'a.ts')); // re-open → foca, sem duplicar no order
    const pane = useWorkspaceStore.getState().panes[0];
    expect(pane.order).toEqual(['a.ts', 'b.ts']);
    expect(pane.activePath).toBe('a.ts');
    expect(useWorkspaceStore.getState().activeFilePath).toBe('a.ts');
  });

  it('setProject dropa as abas do projeto que sai e atualiza activeProjectId', () => {
    const s = useWorkspaceStore.getState();
    s.setProject(1);
    s.openFile(file(1, 'a.ts'));
    expect(useWorkspaceStore.getState().openFiles).toHaveLength(1);
    s.setProject(2);
    expect(useWorkspaceStore.getState().activeProjectId).toBe(2);
    expect(useWorkspaceStore.getState().openFiles).toHaveLength(0); // abas de 1 saíram
    expect(useWorkspaceStore.getState().splitDir).toBeNull(); // volta a painel único
    expect(useWorkspaceStore.getState().panes).toHaveLength(1);
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

  it('separa dirty imediato do espelho de conteúdo debounced do Monaco', () => {
    useWorkspaceStore.setState({
      activeProjectId: 1,
      openFiles: [{ ...file(1, 'x.ts'), content: 'before' }],
      activeFilePath: 'x.ts',
    });

    useWorkspaceStore.getState().markEditorDirty(1, 'x.ts');
    let current = useWorkspaceStore.getState().openFiles[0] as OpenFile;
    expect(current.dirty).toBe(true);
    expect(current.content).toBe('before');

    useWorkspaceStore.getState().syncEditorContent(1, 'x.ts', 'after');
    current = useWorkspaceStore.getState().openFiles[0] as OpenFile;
    expect(current.content).toBe('after');
    expect(current.dirty).toBe(true);

    useWorkspaceStore.getState().markClean(1, 'x.ts', 'mtime');
    useWorkspaceStore.getState().syncEditorContent(1, 'x.ts', 'saved');
    current = useWorkspaceStore.getState().openFiles[0] as OpenFile;
    expect(current.content).toBe('saved');
    expect(current.dirty).toBe(false);
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

  it('closeOthers mantém só o sobrevivente do painel', () => {
    seedSingle(1, ['a.ts', 'b.ts', 'c.ts'], 'b.ts');
    useWorkspaceStore.getState().closeOthers(1, 'b.ts');
    const left = useWorkspaceStore.getState().openFiles;
    expect(left).toHaveLength(1);
    expect(left[0].path).toBe('b.ts');
    expect(useWorkspaceStore.getState().panes[0].order).toEqual(['b.ts']);
  });

  it('closeToTheRight corta as abas à direita da âncora no painel', () => {
    seedSingle(1, ['a.ts', 'b.ts', 'c.ts', 'd.ts'], 'd.ts');
    useWorkspaceStore.getState().closeToTheRight(1, 'b.ts');
    expect(useWorkspaceStore.getState().panes[0].order).toEqual(['a.ts', 'b.ts']);
    expect(useWorkspaceStore.getState().activeFilePath).toBe('b.ts'); // ativo estava à direita → âncora
    expect(useWorkspaceStore.getState().openFiles.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
  });
});

describe('useWorkspaceStore — split de painéis', () => {
  beforeEach(reset);

  it('splitEditor cria um segundo painel VAZIO e o foca', () => {
    seedSingle(1, ['a.ts', 'b.ts'], 'a.ts');
    useWorkspaceStore.getState().splitEditor('row');
    const st = useWorkspaceStore.getState();
    expect(st.splitDir).toBe('row');
    expect(st.panes).toHaveLength(2);
    expect(st.panes[1].order).toEqual([]); // novo painel nasce vazio
    expect(st.activePaneId).toBe(st.panes[1].id);
    expect(st.activeFilePath).toBeNull(); // painel focado está vazio
  });

  it('splitEditor quando já split apenas re-orienta (não adiciona painel)', () => {
    seedSingle(1, ['a.ts'], 'a.ts');
    useWorkspaceStore.getState().splitEditor('row');
    useWorkspaceStore.getState().splitEditor('column');
    const st = useWorkspaceStore.getState();
    expect(st.splitDir).toBe('column');
    expect(st.panes).toHaveLength(2);
  });

  it('openFile com painel novo focado abre lá; depois fechar colapsa o split', () => {
    seedSingle(1, ['a.ts'], 'a.ts');
    useWorkspaceStore.getState().splitEditor('row');
    const paneB = useWorkspaceStore.getState().panes[1].id;
    useWorkspaceStore.getState().openFile(file(1, 'b.ts'));
    let st = useWorkspaceStore.getState();
    expect(st.panes[1].order).toEqual(['b.ts']);
    expect(st.openFiles.map((f) => f.path).sort()).toEqual(['a.ts', 'b.ts']);
    // Fechar a única aba do painel B → colapsa para painel único.
    useWorkspaceStore.getState().closeTabInPane(paneB, 1, 'b.ts');
    st = useWorkspaceStore.getState();
    expect(st.splitDir).toBeNull();
    expect(st.panes).toHaveLength(1);
    expect(st.openFiles.map((f) => f.path)).toEqual(['a.ts']);
  });

  it('moveTabToPane move a aba (remove da origem, insere/foca no destino)', () => {
    seedSingle(1, ['a.ts', 'b.ts'], 'a.ts');
    useWorkspaceStore.getState().splitEditor('row');
    const [paneA, paneB] = useWorkspaceStore.getState().panes.map((p) => p.id);
    useWorkspaceStore.getState().moveTabToPane(paneA, paneB, 'b.ts', null);
    const st = useWorkspaceStore.getState();
    expect(st.panes[0].order).toEqual(['a.ts']);
    expect(st.panes[1].order).toEqual(['b.ts']);
    expect(st.activePaneId).toBe(paneB);
    expect(st.activeFilePath).toBe('b.ts');
    // pool intacto (move não remove do pool)
    expect(st.openFiles.map((f) => f.path).sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('moveTabToPane que esvazia a origem colapsa o split', () => {
    seedSingle(1, ['a.ts'], 'a.ts');
    useWorkspaceStore.getState().splitEditor('row');
    const [paneA, paneB] = useWorkspaceStore.getState().panes.map((p) => p.id);
    useWorkspaceStore.getState().moveTabToPane(paneA, paneB, 'a.ts', null);
    const st = useWorkspaceStore.getState();
    expect(st.splitDir).toBeNull();
    expect(st.panes).toHaveLength(1);
    expect(st.panes[0].order).toEqual(['a.ts']);
  });

  it('unsplit mescla as abas do painel B no A', () => {
    seedSingle(1, ['a.ts', 'b.ts'], 'a.ts');
    useWorkspaceStore.getState().splitEditor('row');
    const [paneA, paneB] = useWorkspaceStore.getState().panes.map((p) => p.id);
    useWorkspaceStore.getState().moveTabToPane(paneA, paneB, 'b.ts', null);
    useWorkspaceStore.getState().unsplit();
    const st = useWorkspaceStore.getState();
    expect(st.splitDir).toBeNull();
    expect(st.panes).toHaveLength(1);
    expect(st.panes[0].order.sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('unsplit mantém a aba do painel FOCADO (não força a do painel A)', () => {
    seedSingle(1, ['a.ts', 'b.ts'], 'a.ts');
    useWorkspaceStore.getState().splitEditor('row');
    const [paneA, paneB] = useWorkspaceStore.getState().panes.map((p) => p.id);
    useWorkspaceStore.getState().moveTabToPane(paneA, paneB, 'b.ts', null); // B=[b.ts], foco em B
    useWorkspaceStore.getState().unsplit();
    expect(useWorkspaceStore.getState().activeFilePath).toBe('b.ts'); // a aba que o user via
  });

  it('closeOthers num painel NÃO focado não rouba o foco', () => {
    seedSingle(1, ['a.ts', 'c.ts'], 'a.ts'); // painel A = SEED_PANE
    useWorkspaceStore.getState().splitEditor('row'); // painel B vazio, focado
    const paneB = useWorkspaceStore.getState().panes[1].id;
    useWorkspaceStore.getState().openFile(file(1, 'b.ts')); // → painel B
    useWorkspaceStore.getState().openFile(file(1, 'd.ts')); // → painel B
    useWorkspaceStore.getState().setActivePane(SEED_PANE); // foco volta p/ A
    useWorkspaceStore.getState().setActive('a.ts');
    useWorkspaceStore.getState().closeOthers(1, 'b.ts'); // poda o painel B (não focado)
    const st = useWorkspaceStore.getState();
    expect(st.activePaneId).toBe(SEED_PANE); // foco preservado em A
    expect(st.activeFilePath).toBe('a.ts');
    expect(st.panes.find((p) => p.id === paneB)?.order).toEqual(['b.ts']);
  });

  it('reorderTab reordena dentro do painel; no-op quando não muda', () => {
    seedSingle(1, ['a.ts', 'b.ts', 'c.ts'], 'a.ts');
    useWorkspaceStore.getState().reorderTab(SEED_PANE, 'c.ts', 'a.ts'); // c antes de a
    expect(useWorkspaceStore.getState().panes[0].order).toEqual(['c.ts', 'a.ts', 'b.ts']);
    const ref = useWorkspaceStore.getState().panes;
    useWorkspaceStore.getState().reorderTab(SEED_PANE, 'c.ts', 'a.ts'); // mesma posição → no-op
    expect(useWorkspaceStore.getState().panes).toBe(ref);
  });

  it('reorderTab com beforePath null faz append', () => {
    seedSingle(1, ['a.ts', 'b.ts', 'c.ts'], 'a.ts');
    useWorkspaceStore.getState().reorderTab(SEED_PANE, 'a.ts', null);
    expect(useWorkspaceStore.getState().panes[0].order).toEqual(['b.ts', 'c.ts', 'a.ts']);
  });
});

describe('abas do editor abertas por outras superfícies', () => {
  beforeEach(reset);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('openDiff coloca a aba no painel ativo e faz refresh in-place (sem duplicar)', () => {
    useWorkspaceStore.setState({ activeProjectId: 1 });
    useWorkspaceStore
      .getState()
      .openDiff({ kind: 'diff', projectId: 1, path: 'diff:a.ts', title: 'a.ts', patch: 'P1', source: 'other' });
    expect(useWorkspaceStore.getState().panes[0].order).toEqual(['diff:a.ts']);
    expect(useWorkspaceStore.getState().activeFilePath).toBe('diff:a.ts');

    useWorkspaceStore
      .getState()
      .openDiff({ kind: 'diff', projectId: 1, path: 'diff:a.ts', title: 'a.ts', patch: 'P2', source: 'other' });
    const pool = useWorkspaceStore.getState().openFiles;
    expect(pool).toHaveLength(1); // refresh, não duplica
    expect((pool[0] as { patch?: string }).patch).toBe('P2');
  });

  it('openDatabaseTab abre e refoca o objeto no editor sem duplicar', () => {
    const tab = {
      kind: 'database' as const,
      projectId: 1,
      path: 'database:data:1:public:users',
      title: 'users',
      workTab: {
        id: 'data:1:public:users',
        kind: 'data' as const,
        title: 'users',
        connectionId: 1,
        connKey: '1',
        schema: 'public',
        table: 'users',
      },
      engine: 'postgres' as const,
      suggestions: ['users', 'id'],
    };
    useWorkspaceStore.getState().openDatabaseTab(tab);
    useWorkspaceStore.getState().openDatabaseTab({ ...tab, suggestions: ['users', 'id', 'email'] });

    const state = useWorkspaceStore.getState();
    expect(state.openFiles).toHaveLength(1);
    expect(state.openFiles[0]).toMatchObject({ kind: 'database', suggestions: ['users', 'id', 'email'] });
    expect(state.panes[0].activePath).toBe(tab.path);
  });

  it.each([
    ['diff', () => useWorkspaceStore.getState().openDiff({ kind: 'diff', projectId: 7, path: 'diff:a.ts', title: 'a.ts', patch: 'P1', source: 'other' })],
    ['branch log', () => useWorkspaceStore.getState().openGitLog({ kind: 'git-log', projectId: 7, path: 'gitlog:main', title: 'Log: main', branch: 'main', isRemote: false })],
    ['stash', () => useWorkspaceStore.getState().openGitStash({ kind: 'git-stash', projectId: 7, path: 'gitstash:0', title: 'Stash abc', stashRef: 'stash@{0}' })],
    ['arquivo SFTP', () => useWorkspaceStore.getState().openSftpFile(sftpFile(7, '/srv/app/Dockerfile'))],
  ])('pede a superficie do editor ao abrir %s', (_label, open) => {
    const browserWindow = new EventTarget();
    const listener = vi.fn();
    browserWindow.addEventListener('mcp:open-files-tab', listener);
    vi.stubGlobal('window', browserWindow);

    open();

    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ projectId: 7 });
  });

  it('repete o pedido ao atualizar a mesma aba virtual', () => {
    const browserWindow = new EventTarget();
    const listener = vi.fn();
    browserWindow.addEventListener('mcp:open-files-tab', listener);
    vi.stubGlobal('window', browserWindow);
    const open = (patch: string) => useWorkspaceStore.getState().openDiff({
      kind: 'diff', projectId: 7, path: 'diff:a.ts', title: 'a.ts', patch, source: 'other',
    });

    open('P1');
    open('P2');

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('preserva seleção, scroll e limite do log ao abrir um diff e voltar', () => {
    useWorkspaceStore.setState({ activeProjectId: 7 });
    const log = {
      kind: 'git-log' as const,
      projectId: 7,
      path: 'gitlog:main',
      title: 'Log: main',
      branch: 'main',
      isRemote: false,
    };

    useWorkspaceStore.getState().openGitLog(log);
    useWorkspaceStore.getState().setGitLogViewState(7, log.path, {
      selectedSha: 'abc123',
      scrollOffset: 1840,
      limit: 250,
    });
    useWorkspaceStore.getState().openDiff({
      kind: 'diff', projectId: 7, path: 'gitshow:abc123:a.ts', title: 'a.ts', patch: 'P1', source: 'other',
    });
    useWorkspaceStore.getState().setActive(log.path);

    let restored = useWorkspaceStore.getState().openFiles.find((f) => f.path === log.path);
    expect(restored?.kind === 'git-log' ? restored.viewState : undefined).toEqual({
      selectedSha: 'abc123', scrollOffset: 1840, limit: 250,
    });

    // Re-clicking the same branch refreshes/focuses the descriptor but must not
    // reset the navigation state of its existing tab.
    useWorkspaceStore.getState().openGitLog({ ...log, title: 'Log: main (refreshed)' });
    restored = useWorkspaceStore.getState().openFiles.find((f) => f.path === log.path);
    expect(restored?.kind === 'git-log' ? restored.viewState : undefined).toEqual({
      selectedSha: 'abc123', scrollOffset: 1840, limit: 250,
    });
  });
});

describe('serializeLayout / hydrateLayout (puro, round-trip)', () => {
  const real = () => true;

  it('persiste descritor e rascunho SQL de abas de banco sem credenciais', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
    const tab: OpenDatabaseTab = {
      kind: 'database', projectId: 1, path: 'database:query:1:7', title: 'Query 1', engine: 'postgres', suggestions: ['users'],
      workTab: { id: 'query:1:7', kind: 'query', title: '', connectionId: 7, connKey: '7', schema: 'public', initialSql: 'SELECT * FROM users', dirty: true },
    };
    savePersistedTabs(1, [tab], tab.path, [{ id: 'pane', order: [tab.path], activePath: tab.path }], null, 'pane');
    expect(loadPersistedTabs(1).databaseTabs?.[0]).toMatchObject({ path: tab.path, workTab: { initialSql: 'SELECT * FROM users' } });
    vi.unstubAllGlobals();
  });

  it('layout legacy (sem campo layout) hidrata como painel único', () => {
    const { panes, splitDir } = hydrateLayout(
      { openFiles: [{ projectId: 1, path: 'a.ts' }], activeFilePath: 'a.ts' },
      ['a.ts'],
    );
    expect(splitDir).toBeNull();
    expect(panes).toHaveLength(1);
    expect(panes[0].order).toEqual(['a.ts']);
    expect(panes[0].activePath).toBe('a.ts');
  });

  it('split round-trip preserva ordem + orientação + painel ativo', () => {
    __resetPaneSeqForTests();
    const panes: EditorPaneState[] = [
      { id: 'pane-1', order: ['a.ts', 'b.ts'], activePath: 'b.ts' },
      { id: 'pane-2', order: ['c.ts'], activePath: 'c.ts' },
    ];
    const layout = serializeLayout(panes, 'column', 'pane-2', real);
    expect(layout).toBeTruthy();
    expect(layout!.splitDir).toBe('column');
    expect(layout!.activePaneIndex).toBe(1);

    const hydrated = hydrateLayout({ openFiles: [], activeFilePath: null, layout }, ['a.ts', 'b.ts', 'c.ts']);
    expect(hydrated.splitDir).toBe('column');
    expect(hydrated.panes.map((p) => p.order)).toEqual([['a.ts', 'b.ts'], ['c.ts']]);
    expect(hydrated.panes[hydrated.panes.findIndex((p) => p.id === hydrated.activePaneId)].activePath).toBe('c.ts');
  });

  it('paths obsoletos são dropados; painel que esvazia some (split → single)', () => {
    const layout = serializeLayout(
      [
        { id: 'pane-1', order: ['a.ts'], activePath: 'a.ts' },
        { id: 'pane-2', order: ['gone.ts'], activePath: 'gone.ts' },
      ],
      'row',
      'pane-1',
      real,
    );
    // 'gone.ts' não está mais no projeto → painel B vazio → colapsa.
    const hydrated = hydrateLayout({ openFiles: [], activeFilePath: null, layout }, ['a.ts']);
    expect(hydrated.splitDir).toBeNull();
    expect(hydrated.panes).toHaveLength(1);
    expect(hydrated.panes[0].order).toEqual(['a.ts']);
  });

  it('serializeLayout dropa painel vazio (split recém-criado → single)', () => {
    const layout = serializeLayout(
      [
        { id: 'pane-1', order: ['a.ts'], activePath: 'a.ts' },
        { id: 'pane-2', order: [], activePath: null },
      ],
      'row',
      'pane-2',
      real,
    );
    expect(layout!.splitDir).toBeNull();
    expect(layout!.panes).toHaveLength(1);
    expect(layout!.activePaneIndex).toBe(0);
  });

  it('serializeLayout filtra paths não-reais (abas virtuais)', () => {
    const isReal = (p: string) => !p.startsWith('diff:');
    const layout = serializeLayout(
      [{ id: 'pane-1', order: ['diff:x.ts', 'a.ts'], activePath: 'diff:x.ts' }],
      null,
      'pane-1',
      isReal,
    );
    expect(layout!.panes[0].order).toEqual(['a.ts']);
    expect(layout!.panes[0].activePath).toBe('a.ts');
  });

  it('serializeLayout não estoura com panes ausente/vazio (regressão do toast "Falha ao abrir diff")', () => {
    // Um call-site com aridade errada passava `panes` undefined, e o `.map`
    // estourava DENTRO de um subscriber síncrono do store → o erro vazava pelo
    // set() até o try/catch do showDiff e virava toast (mesmo o diff abrindo).
    expect(() => serializeLayout(undefined as never, null, '', real)).not.toThrow();
    expect(serializeLayout(undefined as never, null, '', real)).toBeUndefined();
    expect(serializeLayout([], null, '', real)).toBeUndefined();
  });
});
