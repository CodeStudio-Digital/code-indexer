import type { ApiContext } from './common.js';

/**
 * Design System MCP — UI component catalog, design tokens, version management.
 *
 * Source: apps/http-api/server/routes/design-system/{index,versions,sessions,round}.ts
 *
 * Tier gate: `requireTier('pro')` (Freemium plan).
 *
 * Shapes are intentionally loose — DS package types live in
 * @mcp/design-system and @mcp/company/tools/design-system.
 */

export interface DesignSystemPackage {
  id: string;
  name: string;
  version: string;
  description?: string;
  components_count: number;
  tokens_count: number;
  storybook_url?: string;
  created_at: string;
}

export interface DesignSystemSession {
  id: string;
  package_id: string;
  company_session_id: string | null;
  status: string;
  created_at: string;
}

export interface DesignSystemApi {
  packages: {
    list(input: void, ctx: ApiContext): Promise<DesignSystemPackage[]>;
    get(input: { id: string }, ctx: ApiContext): Promise<DesignSystemPackage>;
    upload(input: { name: string; bytes: Uint8Array; filename: string }, ctx: ApiContext): Promise<DesignSystemPackage>;
    delete(input: { id: string }, ctx: ApiContext): Promise<void>;
  };

  versions: {
    list(input: { packageId: string }, ctx: ApiContext): Promise<Array<{ version: string; created_at: string }>>;
    publish(input: { packageId: string; version: string; bytes: Uint8Array }, ctx: ApiContext): Promise<void>;
  };

  sessions: {
    list(input: { packageId?: string }, ctx: ApiContext): Promise<DesignSystemSession[]>;
    create(input: { packageId: string; companySessionId?: string }, ctx: ApiContext): Promise<DesignSystemSession>;
    get(input: { id: string }, ctx: ApiContext): Promise<DesignSystemSession>;
    delete(input: { id: string }, ctx: ApiContext): Promise<void>;
  };

  round: {
    /** Submit a feedback round on the current DS session. */
    submit(input: { sessionId: string; feedback: string }, ctx: ApiContext): Promise<unknown>;
  };
}
