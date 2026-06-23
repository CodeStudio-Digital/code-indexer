/**
 * Deterministic name for the per-session `node_modules` named volume.
 */
export function nodeModulesVolumeFor(sessionId: string): string {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 48);
  return `mcp-sbx-nm-${safe}`;
}

/**
 * Deterministic image tag for a custom-built session image.
 */
export function projectImageTag(sessionId: string, serviceId = 'main'): string {
  const safeSession = String(sessionId).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 48);
  const safeService = String(serviceId).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 32);
  return `mcp-session-${safeSession}-${safeService}:latest`;
}

/**
 * Deterministic docker/podman network name shared by every service of a
 * single company session. Containers attached here address each other
 * by service_id.
 */
export function sessionNetworkName(sessionId: string): string {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 48);
  return `mcp-sbx-net-${safe}`;
}

/**
 * Resolve the runtime CLI binary (docker|podman) to shell out to.
 * Network management is CLI-specific and the `ISandboxDriver` port
 * intentionally stays small (E2B drivers skip these helpers).
 */
export function resolveRuntimeBinary(): 'docker' | 'podman' {
  return process.env.MCP_SANDBOX_RUNTIME === 'podman' ? 'podman' : 'docker';
}
