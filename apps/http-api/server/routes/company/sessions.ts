/**
 * Compatibility export for callers that still import the historical Company
 * session route module. The implementation is the filesystem-only lifecycle;
 * there is deliberately no SQLite-backed alternative behind this path.
 */
export {
  mountCompanyFileSessionRoutes as mountCompanySessionRoutes,
} from './session-files.routes.js';
