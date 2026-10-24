use std::collections::BTreeMap;

use agent_engine::ports::ProviderRequest;
use agent_protocol::generated::v1 as wire;
use prost::Message;

use super::ProviderGatewayError;
use super::mapping::idempotency_key;

pub(super) fn provider_start(
    identity: &wire::AttemptIdentity,
    binding: &wire::ProviderBinding,
    max_context_bytes: usize,
    request: &ProviderRequest,
) -> Result<
    (
        wire::ProviderStart,
        BTreeMap<String, wire::ProviderToolDescriptor>,
    ),
    ProviderGatewayError,
> {
    if request.encoded_context.is_empty() || request.encoded_context.len() > max_context_bytes {
        return Err(ProviderGatewayError::InvalidContext);
    }
    let context = wire::ProviderTurnContext::decode(request.encoded_context.as_ref())
        .map_err(ProviderGatewayError::DecodeContext)?;
    if context.encode_to_vec().as_slice() != request.encoded_context.as_ref() {
        return Err(ProviderGatewayError::NonCanonicalContext);
    }
    let operation_id = request.operation_id.as_str().to_owned();
    let tools = context
        .tools
        .iter()
        .cloned()
        .map(|tool| (tool.capability_name.clone(), tool))
        .collect::<BTreeMap<_, _>>();
    if tools.len() != context.tools.len() {
        return Err(ProviderGatewayError::InvalidContext);
    }
    Ok((
        wire::ProviderStart {
            identity: Some(identity.clone()),
            operation_id: operation_id.clone(),
            binding: Some(binding.clone()),
            system: context.system,
            messages: context.messages,
            tools: context.tools,
            thinking: context.thinking,
            reasoning_effort: context.reasoning_effort,
            thinking_budget_tokens: context.thinking_budget_tokens,
            previous_response_id: context.previous_response_id,
            previous_response_message_count: context.previous_response_message_count,
            prepared_user_context: context.prepared_user_context,
            prepared_boundary_context: context.prepared_boundary_context,
            pending_chapters: context.pending_chapters,
            consumption_ack_required: true,
            deadline_at_unix_ms: request.deadline_at_unix_ms,
            idempotency_key: idempotency_key(identity, operation_id.as_str()),
        },
        tools,
    ))
}
