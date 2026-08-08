use agent_engine::ports::ProviderToolCall;
use agent_protocol::generated::v1 as wire;
use agent_tools::capability::CapabilityExecutionOutcome;
use prost::Message;

use super::ProviderContextError;

mod host_tool_result;

pub fn compose_capability_result_context(
    previous: &[u8],
    call: &ProviderToolCall,
    assistant_text: &str,
    outcome: &CapabilityExecutionOutcome,
    maximum_bytes: usize,
) -> Result<Vec<u8>, ProviderContextError> {
    if previous.is_empty() || maximum_bytes == 0 {
        return Err(ProviderContextError::MalformedTurnContext);
    }
    let mut context = wire::ProviderTurnContext::decode(previous)
        .map_err(|_| ProviderContextError::MalformedTurnContext)?;
    if context.encode_to_vec() != previous {
        return Err(ProviderContextError::NonCanonicalTurnContext);
    }
    if call.capability_name.is_empty()
        || (call.provider_response_id.is_none() && call.provider_response_message_count.is_some())
    {
        return Err(ProviderContextError::InvalidCapabilityResult(
            "provider response authority is incomplete",
        ));
    }
    let mut assistant_content = Vec::with_capacity(2);
    if !assistant_text.is_empty() {
        assistant_content.push(text_block(assistant_text));
    }
    assistant_content.push(wire::ProviderContentBlock {
        body: Some(wire::provider_content_block::Body::ToolUse(
            wire::ProviderToolUseContent {
                tool_use_id: call.tool_use_id.as_str().to_owned(),
                capability_name: call.capability_name.clone(),
                encoded_json_arguments: call.encoded_arguments.clone(),
                arguments_sha256: call.arguments_sha256.to_vec(),
            },
        )),
    });
    context.messages.push(wire::ProviderMessage {
        role: wire::ProviderMessageRole::Assistant as i32,
        content: assistant_content,
        phase: wire::ProviderMessagePhase::Commentary as i32,
        is_meta: false,
    });
    context.messages.push(wire::ProviderMessage {
        role: wire::ProviderMessageRole::Tool as i32,
        content: vec![tool_result_block(call, outcome)?],
        phase: wire::ProviderMessagePhase::Unspecified as i32,
        is_meta: false,
    });
    if let (Some(response_id), Some(message_count)) = (
        call.provider_response_id.as_ref(),
        call.provider_response_message_count,
    ) {
        context.previous_response_id = Some(response_id.clone());
        context.previous_response_message_count = Some(message_count);
    } else {
        context.previous_response_id = None;
        context.previous_response_message_count = None;
    }
    let encoded = context.encode_to_vec();
    if encoded.is_empty() || encoded.len() > maximum_bytes {
        return Err(ProviderContextError::ContextTooLarge {
            length: encoded.len(),
            maximum: maximum_bytes,
        });
    }
    Ok(encoded)
}

fn text_block(text: &str) -> wire::ProviderContentBlock {
    wire::ProviderContentBlock {
        body: Some(wire::provider_content_block::Body::Text(
            wire::ProviderTextContent {
                body: Some(wire::provider_text_content::Body::InlineUtf8(
                    text.to_owned(),
                )),
            },
        )),
    }
}

fn tool_result_block(
    call: &ProviderToolCall,
    outcome: &CapabilityExecutionOutcome,
) -> Result<wire::ProviderContentBlock, ProviderContextError> {
    let (content, is_error, truncated, original_bytes) = host_tool_result::render(outcome)?;
    Ok(wire::ProviderContentBlock {
        body: Some(wire::provider_content_block::Body::ToolResult(
            wire::ProviderToolResultContent {
                tool_use_id: call.tool_use_id.as_str().to_owned(),
                content: Some(wire::provider_tool_result_content::Content::InlineUtf8(
                    content,
                )),
                is_error,
                truncated,
                original_bytes,
            },
        )),
    })
}

#[cfg(test)]
mod tests;
