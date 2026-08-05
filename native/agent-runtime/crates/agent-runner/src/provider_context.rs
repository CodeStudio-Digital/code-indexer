//! Fail-closed composition of the initial provider turn from hydrated inputs.

use agent_protocol::generated::v1 as wire;
use prost::Message;

use crate::control::RunnerExecutionSeed;

mod capability_result;
mod error;
mod snapshots;
mod task;
#[cfg(test)]
mod tests;

pub use capability_result::compose_capability_result_context;
pub use error::ProviderContextError;

/// Read-only access to payloads already verified by the hydration owner.
pub trait ProviderContextMaterial {
    fn snapshot_payload(&self, reference: &wire::SnapshotRef) -> Option<&[u8]>;
    fn artifact_payload(&self, reference: &wire::ArtifactRef) -> Option<&[u8]>;
}

/// Composes the only turn shape currently executable by the Rust engine.
///
/// V1 deliberately accepts only an initial attempt. Resume, fallback and
/// recovery require transcript/checkpoint schemas and remain fail-closed.
pub fn compose_initial_provider_context(
    seed: &RunnerExecutionSeed,
    material: &impl ProviderContextMaterial,
) -> Result<Vec<u8>, ProviderContextError> {
    compose_initial_provider_context_from_spec(seed.as_wire(), material)
}

fn compose_initial_provider_context_from_spec(
    spec: &wire::ResolvedAttemptSpec,
    material: &impl ProviderContextMaterial,
) -> Result<Vec<u8>, ProviderContextError> {
    if wire::AttemptTrigger::try_from(spec.trigger).ok() != Some(wire::AttemptTrigger::Initial) {
        return Err(ProviderContextError::UnsupportedTrigger(spec.trigger));
    }
    if spec.checkpoint_input.is_some() || spec.transcript_input.is_some() {
        return Err(ProviderContextError::ResumeInputUnsupported);
    }

    let definition = snapshots::definition(spec, material)?;
    let capabilities = snapshots::capabilities(spec, material)?;
    let preset = snapshots::preset(spec, material)?;
    let binding =
        spec.provider_binding
            .as_ref()
            .ok_or(ProviderContextError::MissingValidatedField(
                "provider_binding",
            ))?;
    let message = task::initial_user_message(spec, material)?;
    let context = wire::ProviderTurnContext {
        system: Some(wire::ProviderTextContent {
            body: Some(wire::provider_text_content::Body::InlineUtf8(
                definition.system_prompt_utf8,
            )),
        }),
        messages: vec![message],
        tools: capabilities.tools,
        thinking: preset.thinking,
        reasoning_effort: binding.effective_reasoning_effort.clone(),
        thinking_budget_tokens: preset.thinking_budget_tokens,
        previous_response_id: None,
        previous_response_message_count: None,
    };
    let encoded = context.encode_to_vec();
    let maximum = context_byte_limit(spec)?;
    if encoded.is_empty() || encoded.len() > maximum {
        return Err(ProviderContextError::ContextTooLarge {
            length: encoded.len(),
            maximum,
        });
    }
    Ok(encoded)
}

fn context_byte_limit(spec: &wire::ResolvedAttemptSpec) -> Result<usize, ProviderContextError> {
    let budget =
        spec.resource_budget
            .as_ref()
            .ok_or(ProviderContextError::MissingValidatedField(
                "resource_budget",
            ))?;
    usize::try_from(budget.max_hot_transcript_bytes.min(budget.max_ipc_bytes))
        .map_err(|_| ProviderContextError::ContextLimitUnsupported)
}
