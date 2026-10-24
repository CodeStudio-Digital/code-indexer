//! Fail-closed composition of the initial provider turn from hydrated inputs.

use agent_protocol::generated::v1 as wire;
use prost::Message;

use crate::control::RunnerExecutionSeed;

mod capability_result;
mod compaction;
mod error;
mod initial_conversation;
mod prepared;
mod resume;
mod snapshots;
mod task;
#[cfg(test)]
mod tests;

#[cfg(test)]
pub use capability_result::compose_capability_result_context;
pub use capability_result::compose_capability_results_context;
pub use compaction::compact_encoded_context;
pub use error::ProviderContextError;

/// Read-only access to payloads already verified by the hydration owner.
pub trait ProviderContextMaterial {
    fn snapshot_payload(&self, reference: &wire::SnapshotRef) -> Option<&[u8]>;
    fn artifact_payload(&self, reference: &wire::ArtifactRef) -> Option<&[u8]>;
}

/// Composes a provider turn from initial input or an exact durable frontier.
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
    let trigger = wire::AttemptTrigger::try_from(spec.trigger)
        .map_err(|_| ProviderContextError::UnsupportedTrigger(spec.trigger))?;
    if trigger == wire::AttemptTrigger::Unspecified {
        return Err(ProviderContextError::UnsupportedTrigger(spec.trigger));
    }
    if trigger == wire::AttemptTrigger::Initial
        && (spec.checkpoint_input.is_some() || spec.transcript_input.is_some())
    {
        return Err(ProviderContextError::ResumeInputUnsupported);
    }
    if trigger != wire::AttemptTrigger::Initial && spec.initial_conversation_snapshot.is_some() {
        return Err(ProviderContextError::InvalidResumeInput);
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
    let restored = if trigger == wire::AttemptTrigger::Initial {
        None
    } else {
        Some(resume::restore(spec, material)?)
    };
    let conversation = match restored.as_ref() {
        Some(context) => context.clone(),
        None => initial_conversation::context(spec, material)?,
    };
    let mut context = wire::ProviderTurnContext {
        system: Some(wire::ProviderTextContent {
            body: Some(wire::provider_text_content::Body::InlineUtf8(
                definition.system_prompt_utf8,
            )),
        }),
        messages: conversation.messages,
        prepared_user_context: conversation.prepared_user_context,
        prepared_boundary_context: conversation.prepared_boundary_context,
        tools: capabilities.tools,
        thinking: preset.thinking,
        reasoning_effort: binding.effective_reasoning_effort.clone(),
        thinking_budget_tokens: preset.thinking_budget_tokens,
        previous_response_id: restored
            .as_ref()
            .and_then(|context| context.previous_response_id.clone()),
        previous_response_message_count: restored
            .as_ref()
            .and_then(|context| context.previous_response_message_count),
        pending_chapters: Vec::new(),
    };
    let maximum = context_byte_limit(spec)?;
    let session_id = spec
        .identity
        .as_ref()
        .map_or("", |identity| identity.session_id.as_str());
    compaction::compact(&mut context, session_id, maximum)?;
    let encoded = context.encode_to_vec();
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
