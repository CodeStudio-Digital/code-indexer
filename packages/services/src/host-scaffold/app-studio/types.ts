/** Shared shapes for the App Studio workspace scaffold. */

export interface AppWorkspaceFile {
  /** Path relative to the workspace root (POSIX separators). */
  path: string;
  contents: string;
}

export interface AppTemplateInput {
  /** Workspace folder slug (root package.json name). */
  slug: string;
  /** Worker name (wrangler `name`) — imutável pós-scaffold. */
  appSlug: string;
  /** Nome de exibição do app ("Lanchonete da Ana"). */
  appName: string;
}

export interface AppStudioScaffoldInput {
  name: string;
  /** Worker name; default slugify(name). */
  appSlug: string;
  isNameTaken?: (name: string) => boolean;
  /** Override do root de projetos (tests). */
  root?: string;
  signal?: AbortSignal;
  onPhase?: (d: { phase: string; label: string }) => void;
  onLog?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

export type AppStudioScaffoldOutcome =
  | { ok: true; targetPath: string; slug: string; name: string; port: number }
  | { ok: false; targetPath: string | null; error: { message: string; stderrTail?: string } };
