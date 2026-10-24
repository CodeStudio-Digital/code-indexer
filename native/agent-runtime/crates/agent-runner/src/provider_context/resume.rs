use std::collections::BTreeSet;

use agent_protocol::generated::v1 as wire;
use prost::Message;
use sha2::{Digest, Sha256};

use super::{ProviderContextError, ProviderContextMaterial, context_byte_limit};

pub(super) const MEDIA_TYPE: &str = "application/vnd.codestudio.provider-resume.v1+protobuf";

pub(super) fn restore(
    spec: &wire::ResolvedAttemptSpec,
    material: &impl ProviderContextMaterial,
) -> Result<wire::ProviderTurnContext, ProviderContextError> {
    let invalid = || ProviderContextError::InvalidResumeInput;
    // Exactly one authoritative frontier, never a guess between two versions.
    let ((Some(reference), None) | (None, Some(reference))) =
        (&spec.checkpoint_input, &spec.transcript_input)
    else {
        return Err(invalid());
    };
    let identity = spec.identity.as_ref().ok_or_else(invalid)?;
    if reference.media_type != MEDIA_TYPE
        || reference.compression != wire::ArtifactCompression::None as i32
        || reference.owner_session_id != identity.session_id
    {
        return Err(invalid());
    }
    let bytes = material.artifact_payload(reference).ok_or_else(invalid)?;
    if bytes.is_empty()
        || bytes.len() > context_byte_limit(spec)?
        || u64::try_from(bytes.len()).ok() != Some(reference.byte_length)
        || Sha256::digest(bytes).as_slice() != reference.content_sha256
    {
        return Err(invalid());
    }
    let frontier = wire::ProviderResumeContextV1::decode(bytes).map_err(|_| invalid())?;
    if frontier.encode_to_vec() != bytes
        || frontier.schema_version != 1
        || frontier.session_id != identity.session_id
        || frontier.agent_run_id != identity.agent_run_id
        || frontier.source_attempt_id.is_empty()
        || frontier.source_attempt_id == identity.attempt_id
        || !frontier.unresolved_capability_operation_ids.is_empty()
    {
        return Err(invalid());
    }
    let previous_binding = frontier.provider_binding.ok_or_else(invalid)?;
    if previous_binding.effective_provider.is_empty() || previous_binding.effective_model.is_empty()
    {
        return Err(invalid());
    }
    let mut context = frontier.context.ok_or_else(invalid)?;
    validate_frontier(&context)?;
    let binding = spec.provider_binding.as_ref().ok_or_else(invalid)?;
    if binding != &previous_binding {
        context.previous_response_id = None;
        context.previous_response_message_count = None;
    }
    Ok(context)
}

pub(super) fn validate_frontier(
    context: &wire::ProviderTurnContext,
) -> Result<(), ProviderContextError> {
    let invalid = || ProviderContextError::InvalidResumeInput;
    if context.messages.is_empty()
        || context
            .previous_response_id
            .as_ref()
            .is_some_and(String::is_empty)
        || context
            .previous_response_message_count
            .is_some_and(|count| {
                context.previous_response_id.is_none() || count > context.messages.len() as u64
            })
    {
        return Err(invalid());
    }
    let mut pending = BTreeSet::new();
    let mut seen = BTreeSet::new();
    for message in &context.messages {
        let role = wire::ProviderMessageRole::try_from(message.role).map_err(|_| invalid())?;
        if role == wire::ProviderMessageRole::Unspecified
            || message.content.is_empty()
            || (role != wire::ProviderMessageRole::Tool && !pending.is_empty())
        {
            return Err(invalid());
        }
        if role != wire::ProviderMessageRole::Tool {
            seen.clear();
        }
        for block in &message.content {
            match block.body.as_ref().ok_or_else(invalid)? {
                wire::provider_content_block::Body::ToolUse(call) => {
                    if role != wire::ProviderMessageRole::Assistant
                        || call.tool_use_id.is_empty()
                        || call.capability_name.is_empty()
                        || !seen.insert(&call.tool_use_id)
                        || Sha256::digest(&call.encoded_json_arguments).as_slice()
                            != call.arguments_sha256
                    {
                        return Err(invalid());
                    }
                    pending.insert(&call.tool_use_id);
                }
                wire::provider_content_block::Body::ToolResult(result) => {
                    if role != wire::ProviderMessageRole::Tool
                        || result.content.is_none()
                        || !pending.remove(&result.tool_use_id)
                    {
                        return Err(invalid());
                    }
                }
                wire::provider_content_block::Body::Thinking(_)
                    if role != wire::ProviderMessageRole::Assistant =>
                {
                    return Err(invalid());
                }
                _ if role == wire::ProviderMessageRole::Tool => return Err(invalid()),
                _ => {}
            }
        }
    }
    if !pending.is_empty() {
        return Err(invalid());
    }
    super::prepared::validate(context)
}
