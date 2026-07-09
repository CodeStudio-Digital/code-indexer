/**
 * App Studio creation — scaffold do workspace `cf-fullstack` no host +
 * registro:
 *
 *   1. valida input (nome, app_slug = worker name, provider/model);
 *   2. `scaffoldAppStudioWorkspace` (SPA + worker + shadcn + stamp);
 *   3. registra o projeto com `builder_json {stack:'cf-fullstack', port,
 *      kind:'app', appName, appSlug, dbEngine}` — é isso que liga preview,
 *      agente `builder`, tools `app_*` e o bloco de prompt do studio;
 *   4. cria a row `app_studio_sessions` + pipeline inicial (6 etapas,
 *      roadmap vazio — a spec da entrevista o constrói);
 *   5. cria a sessão de chat inicial (`agent: 'builder'`).
 *
 * Espelha o contrato emit-driven do DS Studio: registro só acontece com
 * scaffold ok; diretório meio-escrito nunca é apagado.
 */
import type { Project } from '@mcp/shared/types.js';
import { scaffoldAppStudioWorkspace, slugify } from '@mcp/services/host-scaffold/index.js';
import { CreateProjectService, ProjectError } from '@mcp/services/services/projects/index.js';
import type { AppStudioSession } from '@mcp/store/app-studio-store.js';
import { createPipelineState, serializePipelineState } from '@mcp/app-studio/pipeline/stages.js';
import type { HandlerDeps } from '../types.js';

export interface AppStudioCreateInput {
  name: string;
  /** Worker name (wrangler `name`); default slugify(name). */
  app_slug?: string | null;
  provider: string;
  model: string;
  /** Sticky reasoning-effort override for the app session (null = model default). */
  reasoning_effort?: string | null;
}

export type AppStudioStreamEvent =
  | { event: 'start'; data: { slug: string; targetPath: string } }
  | { event: 'phase'; data: { phase: string; label: string } }
  | { event: 'log'; data: { stream: 'stdout' | 'stderr'; chunk: string } }
  | {
      event: 'done';
      data: { project: Project; app_session: AppStudioSession; coder_session_id: number };
    }
  | { event: 'error'; data: { message: string; stderrTail?: string } };

type Emit = (event: AppStudioStreamEvent) => void;

/** Worker name válido: minúsculas/dígitos/hífens, sem hífen nas pontas. */
const WORKER_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,52}[a-z0-9])?$/;

function resolveAppSlug(input: AppStudioCreateInput): string {
  const raw = input.app_slug?.trim() || slugify(input.name.trim());
  return raw.toLowerCase();
}

function validate(input: AppStudioCreateInput, appSlug: string): string | null {
  if (!input.name?.trim()) return 'name is required.';
  if (!WORKER_NAME_RE.test(appSlug)) {
    return `app_slug '${appSlug}' is not a valid worker name (lowercase letters, digits and hyphens; max 54 chars).`;
  }
  if (!input.provider?.trim() || !input.model?.trim()) return 'provider and model are required.';
  return null;
}

export async function runAppStudioScaffoldStream(
  deps: HandlerDeps,
  input: AppStudioCreateInput,
  emit: Emit,
  signal?: AbortSignal,
): Promise<void> {
  const appSlug = resolveAppSlug(input);
  const invalid = validate(input, appSlug);
  if (invalid) {
    emit({ event: 'error', data: { message: invalid } });
    return;
  }

  const outcome = await scaffoldAppStudioWorkspace({
    name: input.name.trim(),
    appSlug,
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
      description: `App Studio workspace for ${outcome.name}`,
    });
    deps.db.updateProject(project.id, {
      builder_json: JSON.stringify({
        stack: 'cf-fullstack',
        port: outcome.port,
        kind: 'app',
        appName: outcome.name,
        appSlug,
        dbEngine: 'd1',
      }),
    });
    const finalProject = deps.db.getProject(project.id) ?? project;

    let appSession = deps.appStudioStore.createSession({
      project_id: project.id,
      name: outcome.name,
      app_slug: appSlug,
    });
    // Máquina de etapas (6, roadmap vazio — app_save_spec o constrói).
    // Falha aqui nunca derruba a criação — a UI oferece pipeline/init.
    try {
      appSession = deps.appStudioStore.setPipelineJson(
        appSession.id,
        serializePipelineState(createPipelineState()),
      );
    } catch (e) {
      emit({
        event: 'log',
        data: { stream: 'stderr', chunk: `pipeline init failed (non-fatal): ${(e as Error).message}\n` },
      });
    }

    const coderSession = deps.sessionStore.createSession({
      project_id: project.id,
      title: outcome.name,
      provider: input.provider.trim(),
      model: input.model.trim(),
      agent: 'builder',
    });
    // Esforço de raciocínio escolhido no dialog de criação (sticky na sessão).
    const effort = input.reasoning_effort?.trim();
    if (effort) {
      try {
        deps.sessionStore.setSessionReasoningEffort(coderSession.id, effort);
      } catch (e) {
        emit({ event: 'log', data: { stream: 'stderr', chunk: `reasoning effort set failed (non-fatal): ${(e as Error).message}\n` } });
      }
    }

    emit({
      event: 'done',
      data: { project: finalProject, app_session: appSession, coder_session_id: coderSession.id },
    });
  } catch (err) {
    const message = err instanceof ProjectError || err instanceof Error ? err.message : String(err);
    emit({ event: 'error', data: { message: `Scaffold succeeded but registration failed: ${message}` } });
  }
}
