/**
 * Manifest-detector types — describe a project's runtime flavor without
 * committing to how it will be launched. Callers (command-synth, the
 * LocalProcessManager) decide ports, env, and argv based on these hints.
 *
 * Kept deliberately small: only the facts a human would skim from the
 * manifest file itself, plus a couple of filesystem side-observations
 * (`hasNodeModules`, `hasMainGo`) that are cheap to compute here.
 */

export type ManifestKind = 'node' | 'python' | 'go' | 'rust' | 'ruby';

export type NodePackageManager = 'npm' | 'yarn' | 'pnpm';

export interface NodeManifest {
  kind: 'node';
  /** Absolute path to the project root (parent of manifestPath). */
  rootPath: string;
  /** Absolute path to the manifest file itself. */
  manifestPath: string;
  packageManager: NodePackageManager;
  /** Raw `scripts` object from package.json. */
  scripts: Record<string, string>;
  /**
   * Best-guess dev script name ("dev" → "start" → "serve"). `null` when
   * none of the common names is present — the synthesizer falls back to
   * `node <main>` or reports unsupported.
   */
  devScriptName: string | null;
  /** `package.json` "name" field. */
  packageName: string | null;
  /** Whether `node_modules/` is already present. Lets the runner skip install. */
  hasNodeModules: boolean;
}

export type PythonFramework = 'fastapi' | 'flask' | 'django' | 'unknown';

export interface PythonManifest {
  kind: 'python';
  rootPath: string;
  manifestPath: string;
  framework: PythonFramework;
  /**
   * Detected "app" target for ASGI/WSGI runners (e.g. `main:app`). Null
   * when no obvious entry was found — the synthesizer surfaces the miss.
   */
  entry: string | null;
}

export interface GoManifest {
  kind: 'go';
  rootPath: string;
  manifestPath: string;
  moduleName: string;
  /** Whether a top-level `main.go` exists — typical for `go run .`. */
  hasMainGo: boolean;
}

export interface RustManifest {
  kind: 'rust';
  rootPath: string;
  manifestPath: string;
  packageName: string;
  /** List of `[[bin]]` names; empty means the default target is the package. */
  binaries: string[];
}

export type RubyFramework = 'rails' | 'sinatra' | 'unknown';

export interface RubyManifest {
  kind: 'ruby';
  rootPath: string;
  manifestPath: string;
  framework: RubyFramework;
}

export type ManifestInfo =
  | NodeManifest
  | PythonManifest
  | GoManifest
  | RustManifest
  | RubyManifest;
