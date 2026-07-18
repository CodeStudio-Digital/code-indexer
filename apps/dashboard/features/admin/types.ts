export type ProviderKind =
  | 'anthropic'
  | 'claude-code'
  | 'openai'
  | 'deepseek'
  | 'zai'
  | 'gemini'
  | 'bedrock'
  | 'copilot'
  | 'chatgpt'
  | 'google-oauth'
  | 'openrouter'
  | 'kimi-code'
  | 'cloudflare'
  | 'moonshot'
  | 'mistral';

/**
 * Renderer-safe provider visual identity, shipped by the backend from the
 * provider definition. `icon` is a lucide icon NAME (resolved to a component
 * in `provider-icons.tsx`); the two classes are Tailwind fg/bg accents.
 */
export interface ProviderVisualData {
  icon: string;
  fg: string;
  bg: string;
}

/**
 * Declarative settings-form field shipped by the backend from the provider spec
 * (mirror of `@mcp/provider-sdk`'s ConfigField — the dashboard is outside the
 * Node tsc graph). The form renders these without any per-kind code.
 */
export type ConfigFieldType = 'text' | 'password' | 'select' | 'toggle';
export interface ConfigField {
  key: string;
  type: ConfigFieldType;
  label: string;
  storeIn: 'api_key' | 'base_url' | 'extra';
  options?: { value: string; label: string }[];
  placeholder?: string;
  helpText?: string;
  optional?: boolean;
  advanced?: boolean;
  default?: string;
}
export interface ProviderConfigDescriptor {
  fields: ConfigField[];
}

export interface AdminProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  base_url: string | null;
  api_key_masked: string | null;
  has_key: boolean;
  auth_mode: 'api_key' | 'oauth' | 'aws_sigv4';
  enabled: boolean;
  use_for_agent: boolean;
  use_for_coder: boolean;
  use_for_general: boolean;
  is_default: boolean;
  extra: Record<string, unknown>;
  fallback_provider_id: string | null;
  /** Visual identity from the provider definition (null for unknown kinds). */
  visual?: ProviderVisualData | null;
}

export interface AdminModel {
  provider_id: string;
  model_id: string;
  mode: string;
  name: string;
  enabled: boolean;
  source: string;
  default_reasoning_level: string | null;
  supported_reasoning_levels: string[] | null;
  /** Persisted context window in tokens. Null when discovery couldn't resolve it. */
  context_window: number | null;
  /** Completion cap sent to the provider. Null = model registry fallback. */
  default_max_tokens: number | null;
  /** Admin-set tool catalog cap per turn. Null = registry/prefix default. */
  max_tools: number | null;
}

export interface TestResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export const KINDS: ProviderKind[] = [
  'anthropic',
  'claude-code',
  'openai',
  'gemini',
  'bedrock',
  'copilot',
  'chatgpt',
  'google-oauth',
  'openrouter',
  'kimi-code',
  'cloudflare',
  'moonshot',
];

export interface CopilotOpts {
  edition: 'individual' | 'enterprise';
  ghes_host?: string;
  integration_id?: string;
}

export type CopilotFlowState =
  | { state: 'idle' }
  | { state: 'picker' }
  | { state: 'enterprise_form' }
  | { state: 'waiting'; userCode: string; verificationUri: string; deviceCode: string }
  | { state: 'success'; providerId?: string; modelCount?: number }
  | { state: 'error'; message: string };

export type ChatgptFlowState =
  | { state: 'idle' }
  | { state: 'waiting'; authorizeUrl: string; flowState: string }
  | { state: 'success'; providerId?: string; modelCount?: number }
  | { state: 'error'; message: string };

export type ClaudeCodeFlowState =
  | { state: 'idle' }
  | { state: 'waiting'; authorizeUrl: string; manualAuthorizeUrl?: string; flowState: string }
  | { state: 'success'; providerId?: string; modelCount?: number; authType?: string }
  | { state: 'error'; message: string };

export type GoogleFlowState =
  | { state: 'idle' }
  | { state: 'waiting'; authorizeUrl: string; flowState: string }
  | { state: 'success'; providerId?: string; modelCount?: number }
  | { state: 'error'; message: string };

export type KimiCodeFlowState =
  | { state: 'idle' }
  | {
      state: 'waiting';
      verificationUrl: string;
      verificationUriComplete?: string;
      userCode: string;
      flowState: string;
      interval: number;
    }
  | { state: 'success'; providerId?: string; modelCount?: number }
  | { state: 'error'; message: string };
