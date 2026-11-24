import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionLocator } from '@mcp/session-storage';
import { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import { HttpRouter } from '@mcp/shared/http/router.js';
import type { DesignPlan } from '@mcp/company-contracts/designer.js';
import type { ServerDeps } from '../../../deps.js';
import { OperationalSessionFiles } from '../../../operational-session-files.js';
import { mountCompanyChildRoutes } from '../children.js';
import { mountCompanyFileSessionRoutes } from '../session-files.routes.js';
import { mountCompanyKanbanRoutes } from '../kanban.js';
import { generateDesign } from '../design-proposal.js';
import { mountDesignRoutes } from '../design-drafts.js';

/** Real HTTP handlers and filesystem bundles. Only catalog and model inference are fixtures. */
export async function createDesignTestHost(
  root: string,
  reply: { reply: string; changes: Partial<DesignPlan> },
) {
  const projects = [
    { id: 1, name: 'Backend', root_path: join(root, 'back') },
    { id: 2, name: 'Intranet', root_path: join(root, 'front') },
  ];
  await Promise.all(projects.map((project) => mkdir(project.root_path, { recursive: true })));
  const getProject = (id: number) => projects.find((p) => p.id === id) ?? null;
  const locator = new SessionLocator({
    dataDir: root,
    projectRootResolver: {
      resolveProjectRoot: (id) => getProject(id)?.root_path ?? null,
      listProjectRoots: () => projects.map((p) => ({ project_id: p.id, root_path: p.root_path })),
    },
  });
  const store = new FsSessionStore({ locator });
  const sessions = new OperationalSessionFiles({
    locator,
    repository: store.repository,
    catalog: store.catalog,
    projects: { getProject },
  });
  const providers = ['chatgpt', 'bedrock'].map((id) => ({
    id,
    kind: id,
    name: id === 'chatgpt' ? 'ChatGPT' : 'Bedrock',
    enabled: true,
    use_for_coder: true,
  }));
  let available = true;
  const config = {
    config: { dbPath: join(root, 'index.db') },
    db: { listProjects: () => projects, getProject },
    sessionStore: store,
    operationalSessionFiles: sessions,
    modelDiscovery: {
      searchIntent: async () => ({ models: [{ id: 'sol', name: 'Sol', provider: 'chatgpt' }] }),
    },
    providerStore: {
      getProvider: (id: string) => providers.find((p) => p.id === id),
      listProviders: () => providers,
      listModels: () =>
        available
          ? [{ model_id: 'sol', enabled: true, can_reason: true, supported_reasoning_levels: ['max'] }]
          : [],
    },
    companyStore: { getTemplate: () => null, listTemplates: () => [] },
    skillStore: {
      listComposerSkills: () => [{ id: 'contract', name: 'Contratos' }],
      listSkillSummaries: () => ({ items: [{ id: 'contract' }] }),
    },
  } as unknown as ServerDeps;
  const generate: typeof generateDesign = (deps, draft, prompt, p, m, signal) =>
    generateDesign(
      deps,
      draft,
      prompt,
      p,
      m,
      signal,
      async () =>
        ({
          inferenceOnly: true,
          async *chat() {
            yield { type: 'text_delta', text: JSON.stringify(reply) };
            yield { type: 'done' };
          },
        }) as never,
    );
  function router() {
    const app = new HttpRouter();
    mountDesignRoutes(app, config, generate);
    mountCompanyFileSessionRoutes(app, config);
    mountCompanyKanbanRoutes(app, config);
    mountCompanyChildRoutes(app, config);
    app.get('/api/projects', (c) => c.json(projects));
    app.get('/api/company/templates', (c) => c.json([]));
    app.get('/api/coder/providers', (c) =>
      c.json({
        providers: providers.map((p) => ({
          ...p,
          models: [{ id: 'sol', name: 'Sol 6.2', supported_reasoning_levels: ['max'] }],
        })),
      }),
    );
    return app;
  }
  return {
    router,
    store,
    sessions,
    config,
    disable: () => {
      available = false;
    },
  };
}
