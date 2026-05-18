/**
 * One entry in `BuilderSessionConfig.services` — the multi-microservice
 * form. Each describes a container to provision for the session, joined
 * into a shared docker network so they can address each other by hostname.
 */
export interface BuilderServiceConfig {
  /** Stable identifier; doubles as the in-network hostname. */
  serviceId: string;
  /** Human-readable label shown in the dashboard; falls back to serviceId. */
  name?: string;
  /** Free-form stack key validated by the scaffolder registry at runtime. */
  stack: string;
  /** Whether files are builder-owned or an existing user project. */
  mountKind?: 'owned' | 'external';
  /** Whether the image is the MCP default image or built from a project Dockerfile. */
  imageSource?: 'default' | 'project_dockerfile';
  dockerfilePath?: string;
  containerPortOverride?: number;
  skipDefaultCommand?: boolean;
  /** Optional per-service CPU/memory/pids override. */
  limits?: {
    memory?: string;
    cpus?: string;
    pids?: number;
  };
  /** When true, this service is the default preview iframe shown by the UI. */
  primary?: boolean;
}
