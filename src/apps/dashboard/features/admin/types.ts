export type ProviderKind =
  | 'anthropic'
  | 'claude-code'
  | 'openai'
  | 'gemini'
  | 'bedrock'
  | 'copilot'
  | 'chatgpt'
  | 'google-oauth'
  | 'kimi-code';

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
  'kimi-code',
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
