/**
 * Typed view over the `window.mcp` shim the host injects into every plugin
 * webview. esbuild only transpiles plugin UI (no type-check at build), but
 * these types keep the rest of the UI library honest in the editor.
 *
 * This is the canonical accessor: plugins should import `mcp` from
 * `@mcp/plugin-sdk/ui` instead of redefining a per-plugin copy.
 */
export interface ToolResult {
  content: string;
  isError?: boolean;
  data?: unknown;
}

export interface StreamChunk {
  type?: string;
  data?: string;
}

export interface StreamHandlers {
  onData(chunk: StreamChunk): void;
  onEnd?(): void;
  onError?(message: string): void;
}

export interface ModelOption {
  providerId: string;
  modelId: string;
  label: string;
  isDefault?: boolean;
}

export interface AssistantChunk {
  type: 'text' | 'tool_use' | 'tool_result' | 'confirm_request' | 'error' | 'done';
  text?: string;
  name?: string;
  callId?: string;
  input?: unknown;
  isError?: boolean;
  message?: string;
}

export interface AssistantHandlers {
  onData(chunk: AssistantChunk): void;
  onEnd?(): void;
  onError?(message: string): void;
}

export interface Mcp {
  context: { namespace: string; projectId?: number; locale?: string };
  invokeTool(tool: string, args?: Record<string, unknown>): Promise<ToolResult>;
  execStream(cmd: string, args: string[], handlers: StreamHandlers): () => void;
  storage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    list(): Promise<string[]>;
  };
  assistant: {
    listModels(): Promise<ModelOption[]>;
    chat(
      message: string,
      opts: { providerId?: string; modelId?: string; history?: Array<{ role: string; text: string }> },
      handlers: AssistantHandlers,
    ): () => void;
    confirm(callId: string, approved: boolean): Promise<void>;
  };
  ui: {
    confirm(opts: {
      title?: string; message?: string; confirmText?: string; cancelText?: string; danger?: boolean;
    }): Promise<boolean>;
    prompt(opts: {
      title?: string; message?: string; defaultValue?: string; placeholder?: string;
    }): Promise<string | null>;
    alert(opts: { title?: string; message?: string }): Promise<void>;
    toast(opts: { kind: 'info' | 'success' | 'error' | 'warning'; message: string }): Promise<void>;
  };
  i18n: {
    locale: string;
    translator(
      messages: Record<string, Record<string, string>>,
    ): (key: string, vars?: Record<string, unknown>) => string;
  };
}

export const mcp: Mcp = (window as unknown as { mcp: Mcp }).mcp;
