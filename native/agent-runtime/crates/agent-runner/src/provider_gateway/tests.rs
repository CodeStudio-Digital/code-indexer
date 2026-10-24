use agent_engine::operation::OperationId;
use agent_engine::ports::{ProviderEvent, ProviderUsage};
use agent_protocol::generated::v1 as wire;

use super::mapping::{idempotency_key, map_wire_event};
use super::{ProviderDataOperation, settle_provider_event};
use crate::provider_data::ProviderWireEvent;

fn operation() -> OperationId {
    OperationId::new("provider-operation/1").expect("operation")
}

fn identity() -> wire::AttemptIdentity {
    wire::AttemptIdentity {
        session_id: "11111111-1111-4111-8111-111111111111".into(),
        command_id: "22222222-2222-4222-8222-222222222222".into(),
        agent_run_id: "33333333-3333-4333-8333-333333333333".into(),
        attempt_id: "44444444-4444-4444-8444-444444444444".into(),
        executor_owner_id: "host/provider".into(),
        fencing_epoch: 7,
        correlation_id: "55555555-5555-4555-8555-555555555555".into(),
        root_agent_run_id: "33333333-3333-4333-8333-333333333333".into(),
        ..wire::AttemptIdentity::default()
    }
}

#[test]
fn provider_idempotency_is_stable_and_attempt_scoped() {
    let first = idempotency_key(&identity(), operation().as_str());
    assert_eq!(first, idempotency_key(&identity(), operation().as_str()));
    let mut foreign = identity();
    foreign.fencing_epoch += 1;
    assert_ne!(first, idempotency_key(&foreign, operation().as_str()));
    assert_eq!(first.len(), "provider-start/".len() + 64);
}

#[test]
fn final_usage_is_delivered_before_the_buffered_terminal() {
    let mapped = map_wire_event(
        ProviderWireEvent::Terminal(wire::ProviderTerminal {
            operation_id: operation().as_str().into(),
            classification: wire::ProviderTerminalClassification::Completed as i32,
            reason_code: "provider_completed".into(),
            response_id: Some("response/1".into()),
            final_usage: Some(wire::ProviderUsage {
                input_tokens: 10,
                output_tokens: 3,
                cache_read_input_tokens: Some(4),
                cost_micros: Some(8),
                ..wire::ProviderUsage::default()
            }),
            ..wire::ProviderTerminal::default()
        }),
        &operation(),
        &BTreeMap::new(),
    )
    .expect("mapped terminal");

    assert_eq!(
        mapped.event,
        ProviderEvent::Usage(ProviderUsage {
            input_tokens: 10,
            output_tokens: 3,
            cached_input_tokens: 4,
            cost_micros: 8,
        })
    );
    assert_eq!(
        mapped.buffered,
        Some(ProviderEvent::Completed {
            response_id: Some("response/1".into()),
            response_message_count: None,
        })
    );
    assert!(!mapped.terminal_delivered);
}

#[test]
fn tool_call_cannot_cross_an_engine_operation_boundary() {
    let event = ProviderWireEvent::ToolCall(wire::ProviderToolCall {
        operation_id: "provider-operation/other".into(),
        tool_use_id: "tool-use/1".into(),
        capability_name: "filesystem.read".into(),
        encoded_json_arguments: b"{}".to_vec(),
        ..wire::ProviderToolCall::default()
    });

    assert!(map_wire_event(event, &operation(), &BTreeMap::new()).is_err());
}

#[test]
fn tool_call_is_bound_to_the_resolved_capability_descriptor() {
    let mut tools = BTreeMap::new();
    tools.insert(
        "read_file".into(),
        wire::ProviderToolDescriptor {
            capability_name: "read_file".into(),
            capability_id: "native.read_file".into(),
            capability_version: "1".into(),
            execution_class: wire::CapabilityExecutionClass::NativeRead.into(),
            ..wire::ProviderToolDescriptor::default()
        },
    );
    let mapped = map_wire_event(
        ProviderWireEvent::ToolCall(wire::ProviderToolCall {
            operation_id: operation().as_str().into(),
            tool_use_id: "tool-use/1".into(),
            capability_name: "read_file".into(),
            encoded_json_arguments: b"{}".to_vec(),
            arguments_sha256: vec![8; 32],
            ..wire::ProviderToolCall::default()
        }),
        &operation(),
        &tools,
    )
    .expect("resolved tool call");

    let ProviderEvent::ToolCall(call) = mapped.event else {
        panic!("tool call expected");
    };
    assert_eq!(call.capability_id, "native.read_file");
    assert_eq!(call.capability_version, "1");
    assert_eq!(call.arguments_sha256, [8; 32]);
}

#[test]
fn completed_provider_operation_releases_one_tool_call_with_resume_cursor() {
    let mut provider_operation = ProviderDataOperation::new(operation(), BTreeMap::new());
    let call = agent_engine::ports::ProviderToolCall {
        operation_id: operation(),
        tool_use_id: OperationId::new("tool-use/1").expect("tool"),
        capability_name: "read_file".into(),
        capability_id: "native.read_file".into(),
        capability_version: "1".into(),
        execution_class: agent_tools::capability::ExecutionClass::NativeRead,
        mutates: false,
        parallel_safe: false,
        read_only: false,
        encoded_arguments: b"{}".to_vec(),
        arguments_sha256: [8; 32],
        provider_response_id: None,
        provider_response_message_count: None,
    };

    assert_eq!(
        settle_provider_event(&mut provider_operation, ProviderEvent::ToolCall(call))
            .expect("tool boundary"),
        None,
    );
    let resumed = settle_provider_event(
        &mut provider_operation,
        ProviderEvent::Completed {
            response_id: Some("response/1".into()),
            response_message_count: Some(4),
        },
    )
    .expect("provider terminal")
    .expect("released tool call");
    let ProviderEvent::ToolCall(resumed) = resumed else {
        panic!("tool call expected");
    };
    assert_eq!(resumed.provider_response_id.as_deref(), Some("response/1"));
    assert_eq!(resumed.provider_response_message_count, Some(4));
    assert!(!provider_operation.has_pending_tool_call());
}

#[test]
fn stateless_completion_releases_tools_without_manufacturing_a_resume_cursor() {
    let mapped = map_wire_event(
        ProviderWireEvent::Terminal(wire::ProviderTerminal {
            classification: wire::ProviderTerminalClassification::Completed as i32,
            ..wire::ProviderTerminal::default()
        }),
        &operation(),
        &BTreeMap::new(),
    )
    .expect("stateless terminal");
    assert!(matches!(
        mapped.event,
        ProviderEvent::Completed {
            response_id: None,
            ..
        }
    ));
    let mut pending = ProviderDataOperation::new(operation(), BTreeMap::new());
    pending
        .pending_tool_calls
        .push(agent_engine::ports::ProviderToolCall {
            operation_id: operation(),
            tool_use_id: OperationId::new("stateless-tool/1").unwrap(),
            capability_name: "read_file".into(),
            capability_id: "cap:native:read_file".into(),
            capability_version: "1".into(),
            execution_class: agent_tools::capability::ExecutionClass::HostCapability,
            mutates: false,
            parallel_safe: true,
            read_only: true,
            encoded_arguments: b"{}".to_vec(),
            arguments_sha256: [8; 32],
            provider_response_id: None,
            provider_response_message_count: None,
        });
    let Some(ProviderEvent::ToolCall(call)) =
        settle_provider_event(&mut pending, mapped.event).unwrap()
    else {
        panic!("tool not released")
    };
    assert_eq!(call.provider_response_id, None);
    assert_eq!(call.provider_response_message_count, None);
}

mod checkpoint;
mod duplex;
mod duplex_capability;
mod lifetime;
use std::collections::BTreeMap;

#[test]
fn completed_batch_preserves_order_and_cursor_and_rejects_duplicate_ids() {
    let mut provider_operation = ProviderDataOperation::new(operation(), BTreeMap::new());
    let call = agent_engine::ports::ProviderToolCall {
        operation_id: operation(),
        tool_use_id: OperationId::new("tool-use/1").expect("tool"),
        capability_name: "read_file".into(),
        capability_id: "native.read_file".into(),
        capability_version: "1".into(),
        execution_class: agent_tools::capability::ExecutionClass::NativeRead,
        mutates: false,
        parallel_safe: false,
        read_only: false,
        encoded_arguments: b"{}".to_vec(),
        arguments_sha256: [8; 32],
        provider_response_id: None,
        provider_response_message_count: None,
    };
    for index in 0..4 {
        let mut next = call.clone();
        next.tool_use_id = OperationId::new(format!("tool-use/{index}")).expect("tool");
        assert!(
            settle_provider_event(&mut provider_operation, ProviderEvent::ToolCall(next))
                .expect("collect")
                .is_none()
        );
    }
    assert!(settle_provider_event(&mut provider_operation, ProviderEvent::ToolCall(call)).is_err());
    let completed = settle_provider_event(
        &mut provider_operation,
        ProviderEvent::Completed {
            response_id: Some("response/batch".into()),
            response_message_count: Some(1),
        },
    )
    .expect("completed")
    .expect("batch");
    let ProviderEvent::ToolCalls(calls) = completed else {
        panic!("batch expected")
    };
    assert_eq!(calls.len(), 4);
    for (index, call) in calls.iter().enumerate() {
        assert_eq!(call.tool_use_id.as_str(), format!("tool-use/{index}"));
        assert_eq!(call.provider_response_id.as_deref(), Some("response/batch"));
    }
}
