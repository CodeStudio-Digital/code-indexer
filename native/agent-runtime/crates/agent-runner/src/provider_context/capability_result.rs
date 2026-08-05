use agent_engine::ports::ProviderToolCall;
use agent_protocol::generated::v1 as wire;
use agent_tools::capability::{CapabilityExecutionOutcome, CapabilityFailure};
use prost::Message;
use serde_json::json;

use super::ProviderContextError;

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
    let (content, is_error, truncated, original_bytes) = match outcome {
        CapabilityExecutionOutcome::Succeeded(output) => (
            String::from_utf8(output.encoded_result.clone()).map_err(|_| {
                ProviderContextError::InvalidCapabilityResult("result is not UTF-8")
            })?,
            false,
            output.truncated,
            output.truncated.then_some(output.bytes_read),
        ),
        CapabilityExecutionOutcome::Failed(failure) => failure_result("failed", failure),
        CapabilityExecutionOutcome::Cancelled(failure) => failure_result("cancelled", failure),
        CapabilityExecutionOutcome::OutcomeUnknown(failure) => {
            failure_result("outcome_unknown", failure)
        }
    };
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

fn failure_result(kind: &str, failure: &CapabilityFailure) -> (String, bool, bool, Option<u64>) {
    (
        json!({
            "error": {
                "kind": kind,
                "reason_code": failure.reason_code,
            }
        })
        .to_string(),
        true,
        false,
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_engine::operation::OperationId;
    use agent_tools::capability::CapabilityOutput;
    use sha2::{Digest, Sha256};

    #[test]
    fn result_context_preserves_pairing_cursor_and_canonical_bytes() {
        let initial = wire::ProviderTurnContext {
            messages: vec![wire::ProviderMessage {
                role: wire::ProviderMessageRole::User as i32,
                content: vec![text_block("inspect")],
                ..wire::ProviderMessage::default()
            }],
            ..wire::ProviderTurnContext::default()
        }
        .encode_to_vec();
        let call = ProviderToolCall {
            operation_id: OperationId::new("provider/1").expect("operation"),
            tool_use_id: OperationId::new("tool/1").expect("tool"),
            capability_name: "read_file".into(),
            capability_id: "native.read_file".into(),
            capability_version: "1".into(),
            execution_class: agent_tools::capability::ExecutionClass::NativeRead,
            mutates: false,
            encoded_arguments: br#"{"path":"a.txt"}"#.to_vec(),
            arguments_sha256: Sha256::digest(br#"{"path":"a.txt"}"#).into(),
            provider_response_id: Some("response/1".into()),
            provider_response_message_count: Some(1),
        };
        let result = br#"{"content":"hello"}"#.to_vec();
        let outcome = CapabilityExecutionOutcome::Succeeded(CapabilityOutput {
            schema_id: "native.read_file.result".into(),
            schema_version: 1,
            result_sha256: Sha256::digest(&result).into(),
            encoded_result: result,
            bytes_read: 5,
            bytes_emitted: 19,
            truncated: false,
            duration_ms: 1,
        });

        let encoded =
            compose_capability_result_context(&initial, &call, "checking", &outcome, 64 * 1_024)
                .expect("follow-up context");
        let context = wire::ProviderTurnContext::decode(encoded.as_slice()).expect("decode");

        assert_eq!(context.encode_to_vec(), encoded);
        assert_eq!(context.messages.len(), 3);
        assert_eq!(context.previous_response_id.as_deref(), Some("response/1"));
        assert_eq!(context.previous_response_message_count, Some(1));
        let result = &context.messages[2].content[0];
        assert!(matches!(
            result.body,
            Some(wire::provider_content_block::Body::ToolResult(_))
        ));
    }

    #[test]
    fn outcome_unknown_is_returned_as_an_error_without_claiming_a_result() {
        let initial = wire::ProviderTurnContext {
            messages: vec![wire::ProviderMessage {
                role: wire::ProviderMessageRole::User as i32,
                content: vec![text_block("inspect")],
                ..wire::ProviderMessage::default()
            }],
            ..wire::ProviderTurnContext::default()
        }
        .encode_to_vec();
        let input = br#"{"path":"a.txt"}"#;
        let call = ProviderToolCall {
            operation_id: OperationId::new("provider/1").expect("operation"),
            tool_use_id: OperationId::new("tool/1").expect("tool"),
            capability_name: "read_file".into(),
            capability_id: "native.read_file".into(),
            capability_version: "1".into(),
            execution_class: agent_tools::capability::ExecutionClass::NativeRead,
            mutates: false,
            encoded_arguments: input.to_vec(),
            arguments_sha256: Sha256::digest(input).into(),
            provider_response_id: None,
            provider_response_message_count: None,
        };
        let outcome = CapabilityExecutionOutcome::OutcomeUnknown(CapabilityFailure {
            reason_code: "executor_result_ambiguous".into(),
            duration_ms: 0,
        });

        let encoded = compose_capability_result_context(&initial, &call, "", &outcome, 64 * 1_024)
            .expect("unknown follow-up context");
        let context = wire::ProviderTurnContext::decode(encoded.as_slice()).expect("decode");
        let Some(wire::provider_content_block::Body::ToolResult(result)) =
            context.messages.last().unwrap().content[0].body.as_ref()
        else {
            panic!("tool result expected");
        };
        let Some(wire::provider_tool_result_content::Content::InlineUtf8(inline_error)) =
            result.content.as_ref()
        else {
            panic!("inline error expected");
        };
        assert!(result.is_error);
        assert!(inline_error.contains("outcome_unknown"));
        assert!(inline_error.contains("executor_result_ambiguous"));
    }
}
