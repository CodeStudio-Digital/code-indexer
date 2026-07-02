import type * as MonacoNs from 'monaco-editor';
import { languageIdForPath } from '@mcp/shared/utils/language-id.js';
import { useWorkspaceStore } from '../state/workspace.js';
import { parseModelPath } from '../features/workspace/editor/editor-models-path.js';
import { apiCall } from './api-client.js';

type Monaco = typeof MonacoNs;

type ReadResult =
  | { content: string; encoding: 'utf8' | 'base64'; last_modified: string }
  | { notModified: true; last_modified: string };

interface ProjectDTO {
  root_path?: string;
}

interface TempEntry {
  model: MonacoNs.editor.ITextModel;
  refs: number;
  owned: boolean;
}

interface WorkspaceTarget {
  projectId: number;
  relPath: string;
}

class ResolvedTextModel {
  private readonly disposed = new this.monaco.Emitter<void>();
  readonly onWillDispose = this.disposed.event;

  constructor(
    private readonly monaco: Monaco,
    readonly textEditorModel: MonacoNs.editor.ITextModel,
  ) {}

  dispose(): void {
    this.disposed.fire();
    this.disposed.dispose();
  }
}

class ModelReference {
  private disposed = false;

  constructor(
    readonly object: ResolvedTextModel,
    private readonly release: () => void,
  ) {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.object.dispose();
    this.release();
  }
}

function normalizeFsPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\/([a-zA-Z]:\/)/, '$1')
    .replace(/^([a-zA-Z]):/, (_m, drive: string) => `${drive.toLowerCase()}:`);
}

function absoluteToRel(root: string, absolute: string): string | null {
  const r = normalizeFsPath(root).replace(/\/+$/, '');
  const a = normalizeFsPath(absolute);
  if (a.toLowerCase() === r.toLowerCase()) return '';
  if (!a.toLowerCase().startsWith(`${r.toLowerCase()}/`)) return null;
  return a.slice(r.length + 1);
}

export function createWorkspaceTextModelService(monaco: Monaco): {
  createModelReference(resource: MonacoNs.Uri): Promise<ModelReference>;
} {
  const roots = new Map<number, Promise<string | null>>();
  const tempModels = new Map<string, TempEntry>();
  const pendingTempModels = new Map<string, Promise<TempEntry | null>>();

  const refFor = (model: MonacoNs.editor.ITextModel, release: () => void = () => undefined): ModelReference =>
    new ModelReference(new ResolvedTextModel(monaco, model), release);

  const refForTemp = (key: string, entry: TempEntry): ModelReference => {
    if (!entry.owned) return refFor(entry.model);
    entry.refs += 1;
    return refFor(entry.model, () => {
      entry.refs -= 1;
      if (entry.refs > 0 || entry.model.isDisposed()) return;
      tempModels.delete(key);
      entry.model.dispose();
    });
  };

  const projectRoot = (projectId: number): Promise<string | null> => {
    const cached = roots.get(projectId);
    if (cached) return cached;
    const next = apiCall<ProjectDTO>('projects.get', { id: projectId })
      .then((project) => project.root_path ?? null)
      .catch(() => null);
    roots.set(projectId, next);
    return next;
  };

  const workspaceTarget = async (resource: MonacoNs.Uri): Promise<WorkspaceTarget | null> => {
    if (resource.scheme !== 'file') return null;
    const projectId = useWorkspaceStore.getState().activeProjectId;
    if (projectId === null) return null;
    const root = await projectRoot(projectId);
    if (!root) return null;
    const relPath = absoluteToRel(root, resource.fsPath || resource.path);
    return relPath ? { projectId, relPath } : null;
  };

  const liveWorkspaceModel = (target: WorkspaceTarget): MonacoNs.editor.ITextModel | null =>
    monaco.editor.getModels().find((model) => {
      if (model.isDisposed()) return false;
      const parsed = parseModelPath(model.uri.path);
      return (
        parsed.relPath === target.relPath &&
        (parsed.projectId === target.projectId || parsed.projectId === null)
      );
    }) ?? null;

  const readWorkspaceContent = async (target: WorkspaceTarget): Promise<string | null> => {
    const open = useWorkspaceStore.getState().openFiles.find(
      (file) =>
        (file.kind === undefined || file.kind === 'file') &&
        file.projectId === target.projectId &&
        file.path === target.relPath,
    );
    if (open?.content !== null && open?.content !== undefined) return open.content;

    const result = await apiCall<ReadResult>('files.read', {
      projectId: target.projectId,
      path: target.relPath,
    });
    return 'content' in result ? result.content : null;
  };

  const createTempModel = async (
    key: string,
    resource: MonacoNs.Uri,
    target: WorkspaceTarget,
  ): Promise<TempEntry | null> => {
    const existing = tempModels.get(key);
    if (existing && !existing.model.isDisposed()) return existing;

    const pending = pendingTempModels.get(key);
    if (pending) return pending;

    const next = (async (): Promise<TempEntry | null> => {
      const exact = monaco.editor.getModel(resource);
      if (exact && !exact.isDisposed()) {
        return { model: exact, refs: 0, owned: false };
      }

      const content = (await readWorkspaceContent(target).catch(() => null)) ?? '';

      const afterRead = monaco.editor.getModel(resource);
      if (afterRead && !afterRead.isDisposed()) {
        return { model: afterRead, refs: 0, owned: false };
      }

      const model = monaco.editor.createModel(content, languageIdForPath(target.relPath), resource);
      const entry: TempEntry = { model, refs: 0, owned: true };
      tempModels.set(key, entry);
      model.onWillDispose(() => {
        tempModels.delete(key);
      });
      return entry;
    })();

    pendingTempModels.set(key, next);
    try {
      return await next;
    } finally {
      pendingTempModels.delete(key);
    }
  };

  return {
    async createModelReference(resource) {
      const target = await workspaceTarget(resource);
      if (target) {
        const live = liveWorkspaceModel(target);
        if (live) return refFor(live);

        const exact = monaco.editor.getModel(resource);
        if (exact && !exact.isDisposed()) return refFor(exact);

        const key = resource.toString();
        const temp = await createTempModel(key, resource, target);
        if (temp) return refForTemp(key, temp);
      }

      const exact = monaco.editor.getModel(resource);
      if (exact && !exact.isDisposed()) return refFor(exact);

      return Promise.reject(new Error('Model not found'));
    },
  };
}
