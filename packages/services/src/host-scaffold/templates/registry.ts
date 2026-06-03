/**
 * Host-template registry — the single source of truth for which stacks
 * the New Project wizard can scaffold. Mirrors the container scaffolder
 * registry (`../../sandbox/scaffolders/registry.ts`) but for host-side,
 * containerless scaffolding.
 */
import type { HostTemplate, TemplateId } from './types.js';
import { reactViteTemplate, vueTemplate } from './vite.js';
import { angularTemplate } from './angular.js';
import { honoApiTemplate } from './hono.js';
import { cfWorkerTemplate, openNextCfTemplate, viteReactCfTemplate } from './cloudflare.js';
import { nextjsTemplate } from './nextjs.js';
import { gitCloneTemplate } from './git-clone.js';
import { emptyTemplate } from './empty.js';

const TEMPLATES: Record<TemplateId, HostTemplate> = {
  'react-vite': reactViteTemplate,
  vue: vueTemplate,
  angular: angularTemplate,
  'vite-api': honoApiTemplate,
  'cf-worker': cfWorkerTemplate,
  nextjs: nextjsTemplate,
  'opennext-cf': openNextCfTemplate,
  'vite-react-cf': viteReactCfTemplate,
  'git-clone': gitCloneTemplate,
  empty: emptyTemplate,
};

export const TEMPLATE_IDS = Object.keys(TEMPLATES) as TemplateId[];

export function isTemplateId(value: unknown): value is TemplateId {
  return typeof value === 'string' && value in TEMPLATES;
}

export function getHostTemplate(id: TemplateId): HostTemplate {
  const tpl = TEMPLATES[id];
  if (!tpl) throw new Error(`Unknown host template: ${id}`);
  return tpl;
}
