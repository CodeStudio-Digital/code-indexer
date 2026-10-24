use super::*;
use agent_engine::{operation::OperationId, ports::ProviderToolCall};
use agent_tools::capability::{CapabilityOutput, ExecutionClass};
use sha2::{Digest, Sha256};
use std::fmt::Write;

fn encoded(message: &wire::ProviderMessage) -> String {
    let mut hex = String::new();
    for byte in message.encode_to_vec() {
        write!(hex, "{byte:02x}").unwrap();
    }
    hex
}

fn output(extra: &serde_json::Value) -> CapabilityExecutionOutcome {
    let bytes = serde_json::to_vec(&serde_json::json!({
        "content": "image loaded", "isError": false,
        "transport": {"truncated": false, "originalBytes": 12},
        "extraUserMessageHex": extra,
    }))
    .unwrap();
    CapabilityExecutionOutcome::Succeeded(CapabilityOutput {
        schema_id: host_tool_result::SCHEMA_ID.into(),
        schema_version: 1,
        result_sha256: Sha256::digest(&bytes).into(),
        bytes_emitted: bytes.len() as u64,
        encoded_result: bytes,
        bytes_read: 12,
        truncated: false,
        duration_ms: 0,
    })
}

fn user_message() -> wire::ProviderMessage {
    wire::ProviderMessage {
        role: wire::ProviderMessageRole::User as i32,
        content: vec![wire::ProviderContentBlock {
            body: Some(wire::provider_content_block::Body::Attachment(
                wire::ArtifactRef {
                    artifact_id: "c1132100-f744-58ce-b54d-a1ee9e62fbce".into(),
                    media_type: "image/png".into(),
                    byte_length: 10,
                    content_sha256: vec![2; 32],
                    owner_session_id: "session".into(),
                    ..wire::ArtifactRef::default()
                },
            )),
        }],
        ..wire::ProviderMessage::default()
    }
}

#[test]
fn decodes_canonical_user_attachment() {
    let user = user_message();
    assert_eq!(
        message(&output(&encoded(&user).into())).unwrap(),
        Some(user)
    );
}

#[test]
fn rejects_malformed_noncanonical_and_role_injection() {
    let mut user = user_message();
    let correct = encoded(&user);
    for malformed in [
        serde_json::Value::Null,
        "zz".into(),
        "0".into(),
        correct.to_uppercase().into(),
        format!("{correct}0801").into(),
    ] {
        assert!(message(&output(&malformed)).is_err());
    }
    user.role = wire::ProviderMessageRole::Assistant as i32;
    assert!(message(&output(&encoded(&user).into())).is_err());
    user.role = wire::ProviderMessageRole::User as i32;
    user.is_meta = true;
    assert!(message(&output(&encoded(&user).into())).is_err());
}

#[test]
fn preserves_complete_batch_pairing_before_user_attachments() {
    let initial = wire::ProviderTurnContext {
        messages: vec![wire::ProviderMessage {
            role: wire::ProviderMessageRole::User as i32,
            content: vec![super::super::text_block("Inspect")],
            ..wire::ProviderMessage::default()
        }],
        ..wire::ProviderTurnContext::default()
    }
    .encode_to_vec();
    let calls: Vec<_> = ["image", "text"]
        .iter()
        .map(|id| ProviderToolCall {
            operation_id: OperationId::new("provider/1").unwrap(),
            tool_use_id: OperationId::new(*id).unwrap(),
            capability_name: "view_image".into(),
            capability_id: "view_image".into(),
            capability_version: "1".into(),
            execution_class: ExecutionClass::HostCapability,
            mutates: false,
            parallel_safe: true,
            read_only: true,
            encoded_arguments: b"{}".to_vec(),
            arguments_sha256: Sha256::digest(b"{}").into(),
            provider_response_id: None,
            provider_response_message_count: None,
        })
        .collect();
    let outcomes = [
        output(&encoded(&user_message()).into()),
        output(&encoded(&user_message()).into()),
    ];
    let bytes = super::super::compose_capability_results_context(
        &initial,
        &calls,
        "",
        "",
        &outcomes,
        64 * 1024,
    )
    .unwrap();
    let context = wire::ProviderTurnContext::decode(bytes.as_slice()).unwrap();
    let roles: Vec<_> = context.messages.iter().map(|item| item.role).collect();
    assert_eq!(
        roles,
        vec![
            wire::ProviderMessageRole::User as i32,
            wire::ProviderMessageRole::Assistant as i32,
            wire::ProviderMessageRole::Tool as i32,
            wire::ProviderMessageRole::Tool as i32,
            wire::ProviderMessageRole::User as i32,
            wire::ProviderMessageRole::User as i32
        ]
    );
}
