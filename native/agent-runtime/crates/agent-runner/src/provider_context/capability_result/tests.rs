use super::*;
use agent_engine::operation::OperationId;
use agent_tools::capability::{CapabilityFailure, CapabilityOutput, ExecutionClass};
use sha2::{Digest, Sha256};

use super::host_tool_result::{SCHEMA_ID, SCHEMA_VERSION};

#[test]
fn result_context_preserves_pairing_cursor_and_canonical_bytes() {
    let initial = initial_context("inspect");
    let call = ProviderToolCall {
        operation_id: OperationId::new("provider/1").expect("operation"),
        tool_use_id: OperationId::new("tool/1").expect("tool"),
        capability_name: "read_file".into(),
        capability_id: "native.read_file".into(),
        capability_version: "1".into(),
        execution_class: ExecutionClass::NativeRead,
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
    let input = br#"{"path":"a.txt"}"#;
    let call = ProviderToolCall {
        operation_id: OperationId::new("provider/1").expect("operation"),
        tool_use_id: OperationId::new("tool/1").expect("tool"),
        capability_name: "read_file".into(),
        capability_id: "native.read_file".into(),
        capability_version: "1".into(),
        execution_class: ExecutionClass::NativeRead,
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

    let encoded = compose_capability_result_context(
        &initial_context("inspect"),
        &call,
        "",
        &outcome,
        64 * 1_024,
    )
    .expect("unknown follow-up context");
    let result = decode_last_result(&encoded);
    let Some(wire::provider_tool_result_content::Content::InlineUtf8(inline_error)) =
        result.content.as_ref()
    else {
        panic!("inline error expected");
    };
    assert!(result.is_error);
    assert!(inline_error.contains("outcome_unknown"));
    assert!(inline_error.contains("executor_result_ambiguous"));
}

#[test]
fn host_tool_result_is_unwrapped_and_preserves_error_semantics() {
    let result = br#"{"content":"plugin rejected","isError":true,"transport":{"truncated":false,"originalBytes":15}}"#.to_vec();
    let outcome = CapabilityExecutionOutcome::Succeeded(CapabilityOutput {
        schema_id: SCHEMA_ID.into(),
        schema_version: SCHEMA_VERSION,
        result_sha256: Sha256::digest(&result).into(),
        encoded_result: result,
        bytes_read: 15,
        bytes_emitted: 98,
        truncated: false,
        duration_ms: 1,
    });

    let encoded = compose_capability_result_context(
        &initial_context("audit"),
        &tool_call(),
        "",
        &outcome,
        64 * 1_024,
    )
    .expect("host result context");
    let result = decode_last_result(&encoded);
    let Some(wire::provider_tool_result_content::Content::InlineUtf8(content)) =
        result.content.as_ref()
    else {
        panic!("inline result expected");
    };
    assert_eq!(content, "plugin rejected");
    assert!(result.is_error);
    assert!(!result.truncated);
}

#[test]
fn host_tool_result_rejects_a_conflicting_transport_envelope() {
    let result = br#"{"content":"partial","isError":false,"transport":{"truncated":true,"originalBytes":99}}"#.to_vec();
    let outcome = CapabilityExecutionOutcome::Succeeded(CapabilityOutput {
        schema_id: SCHEMA_ID.into(),
        schema_version: SCHEMA_VERSION,
        result_sha256: Sha256::digest(&result).into(),
        encoded_result: result,
        bytes_read: 7,
        bytes_emitted: 88,
        truncated: false,
        duration_ms: 1,
    });

    let error = compose_capability_result_context(
        &initial_context("inspect"),
        &tool_call(),
        "",
        &outcome,
        64 * 1_024,
    )
    .expect_err("conflicting envelope");
    assert!(matches!(
        error,
        ProviderContextError::InvalidCapabilityResult(_)
    ));
}

fn initial_context(text: &str) -> Vec<u8> {
    wire::ProviderTurnContext {
        messages: vec![wire::ProviderMessage {
            role: wire::ProviderMessageRole::User as i32,
            content: vec![text_block(text)],
            ..wire::ProviderMessage::default()
        }],
        ..wire::ProviderTurnContext::default()
    }
    .encode_to_vec()
}

fn decode_last_result(encoded: &[u8]) -> wire::ProviderToolResultContent {
    let context = wire::ProviderTurnContext::decode(encoded).expect("decode");
    let result = context.messages.last().unwrap().content[0]
        .body
        .as_ref()
        .and_then(|body| match body {
            wire::provider_content_block::Body::ToolResult(result) => Some(result),
            _ => None,
        })
        .expect("tool result expected");
    result.clone()
}

fn tool_call() -> ProviderToolCall {
    let input = br#"{}"#;
    ProviderToolCall {
        operation_id: OperationId::new("provider/host").expect("operation"),
        tool_use_id: OperationId::new("tool/host").expect("tool"),
        capability_name: "plugin__quality__audit".into(),
        capability_id: "cap:plugin:plugin__quality__audit".into(),
        capability_version: "1".into(),
        execution_class: ExecutionClass::HostCapability,
        mutates: true,
        encoded_arguments: input.to_vec(),
        arguments_sha256: Sha256::digest(input).into(),
        provider_response_id: None,
        provider_response_message_count: None,
    }
}
