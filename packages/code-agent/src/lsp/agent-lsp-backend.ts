/**
 * Multi-language LSP access for AGENT tools (lsp_definition/references/
 * hover on non-TS files). The real router lives in the main process
 * (api-handlers/lsp: external servers → structural-index fallback); this
 * module is just the seam:
 *
 *   main-process runs  → direct adapter (server.ts wires it at boot)
 *   coder/company worker → RPC shim over MessageBridge (workers/lsp-shim.ts)
 *
 * Module-global by design — mirrors setGlobalDocSearch and friends. When
 * nothing is wired (tests, stripped-down hosts) the tools keep their old
 * "TS only" behavior.
 */

export interface AgentLspPosition {
  line: number;
  column: number;
}

export interface AgentLspLocation {
  /** Absolute canonical path. */
  file: string;
  range: { start: AgentLspPosition; end: AgentLspPosition };
}

export interface AgentLspBackend {
  definition(input: {
    root: string; projectName: string; file: string; position: AgentLspPosition;
  }, signal?: AbortSignal): Promise<AgentLspLocation[] | null>;
  references(input: {
    root: string; projectName: string; file: string; position: AgentLspPosition;
  }, signal?: AbortSignal): Promise<AgentLspLocation[] | null>;
  hover(input: {
    root: string; projectName: string; file: string; position: AgentLspPosition;
  }, signal?: AbortSignal): Promise<{ contents: string } | null>;
}

let backend: AgentLspBackend | null = null;

export function setGlobalAgentLspBackend(b: AgentLspBackend | null): void {
  backend = b;
}

export function getGlobalAgentLspBackend(): AgentLspBackend | null {
  return backend;
}
