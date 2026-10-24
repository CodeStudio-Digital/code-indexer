
export type BindingScopeType = 'global' | 'template';

export interface PipelineProviderBinding {
  id: number;
  pipeline_name: string;
  binding_role: string;
  provider_id: string;
  model_id: string;
  model_mode: string;
  config: Record<string, unknown>;
  scope_type: BindingScopeType;
  scope_id: number | null;
  enabled: boolean;
  priority: number;
  created_at: string;
  updated_at: string;
}

export interface PipelineProviderBindingInput {
  pipeline_name: string;
  binding_role: string;
  provider_id: string;
  model_id: string;
  model_mode?: string;
  config?: Record<string, unknown>;
  scope_type: BindingScopeType;
  scope_id?: number | null;
  enabled?: boolean;
  priority?: number;
}

export interface PipelineBindingActivationInput {
  pipeline_name: string;
  binding_role: string;
  provider_id: string;
  model_id: string;
  model_mode?: string;
  config?: Record<string, unknown>;
  priority?: number;
}

/**
 * One row for {@link PipelineProviderBindingsStore.bulkApplyProfile} — a
 * single (pipeline, role) target the guided-setup wizard wants bound at
 * GLOBAL scope, carrying its OWN per-role config.
 */
export interface PipelineProfileApplyRow {
  pipeline_name: string;
  binding_role: string;
  provider_id: string;
  model_id: string;
  model_mode?: string;
  config?: Record<string, unknown>;
}

export interface RawRow {
  id: number;
  pipeline_name: string;
  binding_role: string;
  provider_id: string;
  model_id: string;
  model_mode: string;
  config_json: string;
  scope_type: string;
  scope_id: number | null;
  enabled: number;
  priority: number;
  created_at: string;
  updated_at: string;
}
