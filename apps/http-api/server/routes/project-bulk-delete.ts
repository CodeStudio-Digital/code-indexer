import { lstat, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  isAbsolute,
  normalize,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';

export interface BulkProjectDeleteInput {
  projectIds: number[];
  confirm: boolean;
  deleteFolders?: boolean;
  folderConfirmation?: string;
}

export interface BulkDeleteProject {
  id: number;
  name: string;
  root_path: string;
}

export type FolderDeleteStatus =
  | 'not_requested'
  | 'deleted'
  | 'already_missing'
  | 'skipped'
  | 'failed';

export interface BulkProjectDeleteItemResult {
  id: number;
  name: string;
  root_path: string;
  catalog_deleted: boolean;
  folder_status: FolderDeleteStatus;
  error: string | null;
}

export interface BulkProjectDeleteResult {
  ok: boolean;
  projects_deleted: number;
  folders_deleted: number;
  folders_missing: number;
  results: BulkProjectDeleteItemResult[];
}

export class BulkProjectDeleteError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'BulkProjectDeleteError';
  }
}

interface PreparedFolder {
  exists: boolean;
  project: BulkDeleteProject;
  resolvedPath: string;
}

interface BulkProjectDeleteDeps {
  getProject: (id: number) => BulkDeleteProject | null | undefined;
  listProjects: () => BulkDeleteProject[];
  deleteCatalogProject: (id: number) => Promise<void>;
  removeDirectory?: (path: string) => Promise<void>;
  cwd?: string;
  homeDir?: string;
  protectedSystemPaths?: string[];
}

function comparisonPath(path: string): string {
  const value = normalize(resolve(path));
  return process.platform === 'win32' ? value.toLocaleLowerCase('en-US') : value;
}

function isSameOrParent(parent: string, candidate: string): boolean {
  const rel = relative(comparisonPath(parent), comparisonPath(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  return String((error as { code?: unknown }).code ?? '');
}

function defaultProtectedSystemPaths(): string[] {
  if (process.platform === 'win32') {
    return [
      process.env.SystemRoot,
      process.env.ProgramFiles,
      process.env.ProgramW6432,
      process.env['ProgramFiles(x86)'],
      process.env.ProgramData,
    ].filter((path): path is string => !!path);
  }
  return [
    '/bin',
    '/boot',
    '/dev',
    '/etc',
    '/lib',
    '/lib64',
    '/proc',
    '/sbin',
    '/sys',
    '/usr',
    '/var',
  ];
}

function validateRequest(input: BulkProjectDeleteInput): number[] {
  if (input.confirm !== true) {
    throw new BulkProjectDeleteError('explicit confirmation is required');
  }
  if (input.deleteFolders !== undefined && typeof input.deleteFolders !== 'boolean') {
    throw new BulkProjectDeleteError('deleteFolders must be a boolean');
  }
  if (input.deleteFolders && input.folderConfirmation !== 'DELETE_FOLDERS') {
    throw new BulkProjectDeleteError('folder deletion requires explicit folder confirmation');
  }
  if (!Array.isArray(input.projectIds) || input.projectIds.length === 0) {
    throw new BulkProjectDeleteError('projectIds must contain at least one project');
  }
  if (input.projectIds.length > 500) {
    throw new BulkProjectDeleteError('at most 500 projects can be deleted at once');
  }
  const ids = [...new Set(input.projectIds)];
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new BulkProjectDeleteError('projectIds must contain positive integers');
  }
  return ids;
}

async function prepareFolder(
  project: BulkDeleteProject,
  protectedPaths: { cwd: string; homeDir: string; systemTrees: string[] },
): Promise<PreparedFolder> {
  if (!isAbsolute(project.root_path)) {
    throw new BulkProjectDeleteError(
      `project "${project.name}" has a non-absolute root path and its folder cannot be deleted`,
    );
  }
  const resolvedPath = normalize(resolve(project.root_path));
  const volumeRoot = normalize(parse(resolvedPath).root);
  if (comparisonPath(resolvedPath) === comparisonPath(volumeRoot)) {
    throw new BulkProjectDeleteError(`refusing to delete filesystem root "${resolvedPath}"`);
  }
  if (isSameOrParent(resolvedPath, protectedPaths.cwd)) {
    throw new BulkProjectDeleteError(
      `refusing to delete "${resolvedPath}" because CodeStudio is running inside it`,
    );
  }
  if (isSameOrParent(resolvedPath, protectedPaths.homeDir)) {
    throw new BulkProjectDeleteError(
      `refusing to delete "${resolvedPath}" because it contains the user home directory`,
    );
  }
  const protectedSystemTree = protectedPaths.systemTrees.find(
    (path) => isSameOrParent(path, resolvedPath) || isSameOrParent(resolvedPath, path),
  );
  if (protectedSystemTree) {
    throw new BulkProjectDeleteError(
      `refusing to delete protected system path "${resolvedPath}"`,
    );
  }

  let stat;
  try {
    stat = await lstat(resolvedPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { exists: false, project, resolvedPath };
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new BulkProjectDeleteError(
      `refusing to recursively delete linked project root "${resolvedPath}"`,
    );
  }
  if (!stat.isDirectory()) {
    throw new BulkProjectDeleteError(`project root "${resolvedPath}" is not a directory`);
  }

  const canonicalPath = normalize(await realpath(resolvedPath));
  if (comparisonPath(canonicalPath) !== comparisonPath(resolvedPath)) {
    throw new BulkProjectDeleteError(
      `refusing to recursively delete aliased or junction project root "${resolvedPath}"`,
    );
  }
  if (
    comparisonPath(canonicalPath) === comparisonPath(parse(canonicalPath).root)
    || isSameOrParent(canonicalPath, protectedPaths.cwd)
    || isSameOrParent(canonicalPath, protectedPaths.homeDir)
    || protectedPaths.systemTrees.some(
      (path) => isSameOrParent(path, canonicalPath) || isSameOrParent(canonicalPath, path),
    )
  ) {
    throw new BulkProjectDeleteError(`refusing to delete protected path "${canonicalPath}"`);
  }

  return { exists: true, project, resolvedPath: canonicalPath };
}

async function prepareFolders(
  selectedProjects: BulkDeleteProject[],
  allProjects: BulkDeleteProject[],
  deps: Pick<BulkProjectDeleteDeps, 'cwd' | 'homeDir' | 'protectedSystemPaths'>,
): Promise<Map<number, PreparedFolder>> {
  const systemTrees = (deps.protectedSystemPaths ?? defaultProtectedSystemPaths())
    .map((path) => resolve(path));
  const protectedPaths = {
    cwd: resolve(deps.cwd ?? process.cwd()),
    homeDir: resolve(deps.homeDir ?? homedir()),
    systemTrees,
  };
  const prepared = await Promise.all(
    selectedProjects.map((project) => prepareFolder(project, protectedPaths)),
  );
  const selectedIds = new Set(selectedProjects.map((project) => project.id));

  for (const folder of prepared) {
    for (const other of allProjects) {
      if (selectedIds.has(other.id) || !isAbsolute(other.root_path)) continue;
      if (isSameOrParent(folder.resolvedPath, resolve(other.root_path))) {
        throw new BulkProjectDeleteError(
          `cannot delete "${folder.resolvedPath}" because it contains unselected project "${other.name}"`,
        );
      }
    }
  }

  const roots = new Map<string, BulkDeleteProject>();
  for (const folder of prepared) {
    const key = comparisonPath(folder.resolvedPath);
    const duplicate = roots.get(key);
    if (duplicate) {
      throw new BulkProjectDeleteError(
        `projects "${duplicate.name}" and "${folder.project.name}" share the same root folder`,
      );
    }
    roots.set(key, folder.project);
  }

  return new Map(prepared.map((folder) => [folder.project.id, folder]));
}

export async function executeBulkProjectDelete(
  input: BulkProjectDeleteInput,
  deps: BulkProjectDeleteDeps,
): Promise<BulkProjectDeleteResult> {
  const ids = validateRequest(input);
  const selectedProjects = ids
    .map((id) => deps.getProject(id))
    .filter((project): project is BulkDeleteProject => !!project);
  const missingIds = ids.filter((id) => !selectedProjects.some((project) => project.id === id));
  const preparedFolders = input.deleteFolders
    ? await prepareFolders(selectedProjects, deps.listProjects(), deps)
    : new Map<number, PreparedFolder>();
  const order = input.deleteFolders
    ? [...selectedProjects].sort((left, right) => right.root_path.length - left.root_path.length)
    : selectedProjects;
  const removeDirectory = deps.removeDirectory
    ?? ((path: string) => rm(path, { recursive: true, force: false, maxRetries: 3 }));
  const results: BulkProjectDeleteItemResult[] = missingIds.map((id) => ({
    id,
    name: `#${id}`,
    root_path: '',
    catalog_deleted: false,
    folder_status: input.deleteFolders ? 'skipped' : 'not_requested',
    error: 'project not found',
  }));

  for (const project of order) {
    const result: BulkProjectDeleteItemResult = {
      id: project.id,
      name: project.name,
      root_path: project.root_path,
      catalog_deleted: false,
      folder_status: input.deleteFolders ? 'skipped' : 'not_requested',
      error: null,
    };
    try {
      await deps.deleteCatalogProject(project.id);
      result.catalog_deleted = true;
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      results.push(result);
      continue;
    }

    if (input.deleteFolders) {
      const folder = preparedFolders.get(project.id)!;
      if (!folder.exists) {
        result.folder_status = 'already_missing';
      } else {
        try {
          await removeDirectory(folder.resolvedPath);
          result.folder_status = 'deleted';
        } catch (error) {
          result.folder_status = 'failed';
          result.error = `project removed, but folder deletion failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }
    }
    results.push(result);
  }

  return {
    ok: results.every((result) => result.error === null),
    projects_deleted: results.filter((result) => result.catalog_deleted).length,
    folders_deleted: results.filter((result) => result.folder_status === 'deleted').length,
    folders_missing: results.filter((result) => result.folder_status === 'already_missing').length,
    results,
  };
}
