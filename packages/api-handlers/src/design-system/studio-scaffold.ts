/**
 * DS Studio creation — scaffold do workspace no host + registro:
 *
 *   1. valida input (nome, package npm, stack, provider/model);
 *   2. `scaffoldDsStudioWorkspace` (galeria + lib + instrumentação);
 *   3. registra o projeto com `builder_json {stack, port, kind:'ds',
 *      packageName}` — é isso que liga preview, agente `builder`, tools
 *      `ds_*` e o bloco de prompt do studio;
 *   4. cria a row `design_system_sessions` (kind='studio');
 *   5. cria a sessão de chat inicial (`agent: 'builder'`).
 *
 * Espelha o contrato emit-driven de `projects/scaffold.ts`: registro só
 * acontece com scaffold ok; diretório meio-escrito nunca é apagado.
 */
import type { Project } from '@mcp/shared/types.js';
import {
  scaffoldDsStudioWorkspace,
  type DsStudioStack,
} from '@mcp/services/host-scaffold/index.js';
import { CreateProjectService, ProjectError } from '@mcp/services/services/projects/index.js';
import type { DesignSystemSession } from '@mcp/store/design-system-store.js';
import type { HandlerDeps } from '../types.js';

export interface DsStudioCreateInput {
  name: string;
  package_name: string;
  stack: DsStudioStack;
  provider: string;
  model: string;
  /** Zip já persistido no disco (a rota cuida do upload). */
  import_zip_path?: string | null;
  import_zip_hash?: string | null;
}

export type DsStudioStreamEvent =
  | { event: 'start'; data: { slug: string; targetPath: string } }
  | { event: 'phase'; data: { phase: string; label: string } }
  | { event: 'log'; data: { stream: 'stdout' | 'stderr'; chunk: string } }
  | {
      event: 'done';
      data: { project: Project; ds_session: DesignSystemSession; coder_session_id: number };
    }
  | { event: 'error'; data: { message: string; stderrTail?: string } };

type Emit = (event: DsStudioStreamEvent) => void;

const STACKS: ReadonlySet<string> = new Set(['react-ts', 'vue-ts', 'angular']);
// npm package name (escopo opcional) — mesma gramática do registro npm.
const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

function validate(input: DsStudioCreateInput): string | null {
  if (!input.name?.trim()) return 'name is required.';
  if (!input.package_name?.trim() || !NPM_NAME_RE.test(input.package_name.trim())) {
    return `package_name '${input.package_name ?? ''}' is not a valid npm package name.`;
  }
  if (!STACKS.has(input.stack)) {
    return `Invalid stack '${input.stack}'. Use react-ts, vue-ts or angular.`;
  }
  if (!input.provider?.trim() || !input.model?.trim()) return 'provider and model are required.';
  return null;
}

export async function runDsStudioScaffoldStream(
  deps: HandlerDeps,
  input: DsStudioCreateInput,
  emit: Emit,
  signal?: AbortSignal,
): Promise<void> {
  const invalid = validate(input);
  if (invalid) {
    emit({ event: 'error', data: { message: invalid } });
    return;
  }
  const packageName = input.package_name.trim();

  const outcome = await scaffoldDsStudioWorkspace({
    name: input.name.trim(),
    packageName,
    stack: input.stack,
    importZipPath: input.import_zip_path ?? null,
    isNameTaken: (name) => !!deps.db.getProjectByName(name),
    signal,
    onPhase: (data) => emit({ event: 'phase', data }),
    onLog: (stream, chunk) => emit({ event: 'log', data: { stream, chunk } }),
  });
  if (!outcome.ok) {
    emit({ event: 'error', data: outcome.error });
    return;
  }
  emit({ event: 'start', data: { slug: outcome.slug, targetPath: outcome.targetPath } });

  emit({ event: 'phase', data: { phase: 'register', label: 'Registering workspace' } });
  try {
    const project = new CreateProjectService(deps.db).execute({
      name: outcome.name,
      root_path: outcome.targetPath,
      description: `Design System workspace for ${packageName}`,
    });
    deps.db.updateProject(project.id, {
      builder_json: JSON.stringify({
        stack: input.stack,
        port: outcome.port,
        kind: 'ds',
        packageName,
      }),
    });
    const finalProject = deps.db.getProject(project.id) ?? project;

    const dsSession = deps.designSystemStore.createStudioSession({
      project_id: project.id,
      name: outcome.name,
      package_name: packageName,
      stack: input.stack,
      source_zip_hash: input.import_zip_hash ?? null,
      source_zip_path: input.import_zip_path ?? null,
    });

    const coderSession = deps.sessionStore.createSession({
      project_id: project.id,
      title: outcome.name,
      provider: input.provider.trim(),
      model: input.model.trim(),
      agent: 'builder',
    });

    emit({
      event: 'done',
      data: { project: finalProject, ds_session: dsSession, coder_session_id: coderSession.id },
    });
  } catch (err) {
    const message = err instanceof ProjectError || err instanceof Error ? err.message : String(err);
    emit({ event: 'error', data: { message: `Scaffold succeeded but registration failed: ${message}` } });
  }
}
