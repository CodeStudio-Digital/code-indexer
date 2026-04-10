import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { mountCompanyTemplateRoutes } from './templates.js';
import { mountCompanySessionRoutes } from './sessions.js';
import { mountCompanyStreamRoutes } from './stream.js';
import { mountCompanyBoardRoutes } from './board.js';

export function mountCompanyRoutes(app: Hono, deps: ServerDeps): void {
  mountCompanyTemplateRoutes(app, deps);
  mountCompanySessionRoutes(app, deps);
  mountCompanyStreamRoutes(app, deps);
  mountCompanyBoardRoutes(app, deps);
}
