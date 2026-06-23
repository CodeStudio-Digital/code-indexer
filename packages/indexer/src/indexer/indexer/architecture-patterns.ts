/**
 * Filename-based heuristic patterns the auto-snapshot module surfaces in the
 * "Design Patterns Detected" entry. Pure: takes a list of paths and returns
 * the patterns whose filename signal hits. No DB access, no I/O.
 */
export interface DetectedPattern {
  name: string;
  description: string;
  files: string[];
}

export function detectArchitecturalPatterns(
  files: Array<{ path: string; lower: string }>,
): DetectedPattern[] {
  const patterns: DetectedPattern[] = [];
  const pathMap = files;

  const controllers = pathMap.filter((p) => p.lower.includes('controller'));
  const services = pathMap.filter((p) => p.lower.includes('service') && !p.lower.includes('worker'));
  if (controllers.length > 0 && services.length > 0) {
    patterns.push({
      name: 'MVC / Service Layer',
      description: `${controllers.length} controllers + ${services.length} services. Controllers handle routing/input, services contain business logic.`,
      files: [...controllers.map((c) => c.path), ...services.map((s) => s.path)],
    });
  }

  const repos = pathMap.filter((p) =>
    p.lower.includes('repository') || p.lower.includes('repo') || p.lower.match(/store.*db|db.*store/),
  );
  if (repos.length > 0) {
    patterns.push({
      name: 'Repository / Data Access',
      description: `${repos.length} data access files. Centralized database access through repository abstraction.`,
      files: repos.map((r) => r.path),
    });
  }

  const middleware = pathMap.filter((p) => p.lower.includes('middleware'));
  if (middleware.length > 0) {
    patterns.push({
      name: 'Middleware Pipeline',
      description: `${middleware.length} middleware files. Request/response processing chain.`,
      files: middleware.map((m) => m.path),
    });
  }

  const providers = pathMap.filter((p) => p.lower.includes('provider'));
  if (providers.length >= 2) {
    patterns.push({
      name: 'Provider / Strategy Pattern',
      description: `${providers.length} provider implementations. Multiple interchangeable implementations behind a common interface.`,
      files: providers.map((p) => p.path),
    });
  }

  const factories = pathMap.filter((p) => p.lower.includes('factory'));
  if (factories.length > 0) {
    patterns.push({
      name: 'Factory Pattern',
      description: `${factories.length} factory files. Object creation through factory methods.`,
      files: factories.map((f) => f.path),
    });
  }

  const hooks = pathMap.filter((p) => p.lower.includes('hook') || p.lower.includes('composable') || p.lower.match(/use[A-Z]/));
  if (hooks.length > 0) {
    patterns.push({
      name: 'Hooks / Composables',
      description: `${hooks.length} hook/composable files. Reusable stateful logic units.`,
      files: hooks.map((h) => h.path),
    });
  }

  const stateFiles = pathMap.filter((p) => p.lower.includes('store') || p.lower.includes('redux') || p.lower.includes('zustand') || p.lower.includes('state'));
  if (stateFiles.length > 0) {
    patterns.push({
      name: 'State Management',
      description: `${stateFiles.length} state management files.`,
      files: stateFiles.map((s) => s.path),
    });
  }

  const workers = pathMap.filter((p) => p.lower.includes('worker') || p.lower.includes('queue') || p.lower.includes('job'));
  if (workers.length > 0) {
    patterns.push({
      name: 'Workers / Background Processing',
      description: `${workers.length} worker/job files. Background task processing.`,
      files: workers.map((w) => w.path),
    });
  }

  const events = pathMap.filter((p) => p.lower.includes('event') || p.lower.includes('emitter') || p.lower.includes('webhook') || p.lower.includes('dispatcher'));
  if (events.length > 0) {
    patterns.push({
      name: 'Event-Driven / Webhooks',
      description: `${events.length} event/webhook files. Async communication via events or webhooks.`,
      files: events.map((e) => e.path),
    });
  }

  const routes = pathMap.filter((p) => p.lower.includes('route') || p.lower.includes('api/') || p.lower.includes('endpoint'));
  if (routes.length > 0) {
    patterns.push({
      name: 'API Routes',
      description: `${routes.length} route/API files. HTTP endpoint definitions.`,
      files: routes.map((r) => r.path),
    });
  }

  const configs = pathMap.filter((p) => p.lower.includes('config'));
  if (configs.length > 0) {
    patterns.push({
      name: 'Configuration Management',
      description: `${configs.length} config files. Centralized configuration with environment variable overrides.`,
      files: configs.map((c) => c.path),
    });
  }

  return patterns;
}
