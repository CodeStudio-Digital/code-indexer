use agent_protocol::frame::FrameReceiveOutcome;
use agent_protocol::generated::v1 as wire;
use agent_protocol::testing::established_data_duplex;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio::time::Instant;

use super::validation::{
    timestamp_within_local_peer, validate_cancel, validate_start, validate_stream_event,
};
use super::{ProviderDataClient, ProviderDataError, ProviderDataTiming};

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

fn start() -> wire::ProviderStart {
    wire::ProviderStart {
        identity: Some(identity()),
        operation_id: "provider-operation/1".into(),
        binding: Some(wire::ProviderBinding {
            effective_provider: "test-provider".into(),
            effective_model: "test-model".into(),
            ..wire::ProviderBinding::default()
        }),
        deadline_at_unix_ms: 1_000,
        idempotency_key: "provider-start/1".into(),
        ..wire::ProviderStart::default()
    }
}

#[test]
fn start_and_cancel_require_exact_operation_authority() {
    validate_start(&start(), &identity()).expect("valid start");
    let mut foreign = start();
    foreign.identity.as_mut().expect("identity").fencing_epoch = 8;
    assert!(matches!(
        validate_start(&foreign, &identity()),
        Err(ProviderDataError::InvalidRequest(_))
    ));

    let cancel = wire::ProviderCancel {
        identity: Some(identity()),
        operation_id: "provider-operation/1".into(),
        reason_code: "cancelled".into(),
        idempotency_key: "provider-cancel/1".into(),
    };
    validate_cancel(&cancel, &identity(), "provider-operation/1").expect("valid cancel");
    assert!(validate_cancel(&cancel, &identity(), "provider-operation/other").is_err());
}

#[test]
fn provider_response_clock_skew_is_bounded_between_local_processes() {
    assert!(timestamp_within_local_peer(99, 100, 120));
    assert!(timestamp_within_local_peer(121, 100, 120));
    assert!(!timestamp_within_local_peer(49, 100, 120));
    assert!(!timestamp_within_local_peer(171, 100, 120));
}

#[test]
fn provider_stream_requires_no_reply_and_exact_monotonic_sequence() {
    let body = wire::frame_payload::Body::ProviderTextDelta(wire::ProviderTextDelta {
        identity: Some(identity()),
        operation_id: "provider-operation/1".into(),
        event_sequence: 1,
        text: "answer".into(),
        ..wire::ProviderTextDelta::default()
    });
    let header = wire::FrameHeader::default();
    validate_stream_event(body.clone(), &header, "provider-operation/1", 1)
        .expect("valid stream event");
    assert!(matches!(
        validate_stream_event(body.clone(), &header, "provider-operation/1", 2),
        Err(ProviderDataError::Correlation(_))
    ));
    let mut replied = header;
    replied.reply_to_message_id = Some("request".into());
    assert!(matches!(
        validate_stream_event(body, &replied, "provider-operation/1", 1),
        Err(ProviderDataError::Correlation(_))
    ));
}

#[test]
fn terminal_is_the_only_event_that_closes_the_wire_operation() {
    let terminal = wire::frame_payload::Body::ProviderTerminal(wire::ProviderTerminal {
        identity: Some(identity()),
        operation_id: "provider-operation/1".into(),
        event_sequence: 1,
        classification: wire::ProviderTerminalClassification::Completed as i32,
        reason_code: "provider_completed".into(),
        response_id: Some("response/1".into()),
        completed_at_unix_ms: 10,
        ..wire::ProviderTerminal::default()
    });
    let event = validate_stream_event(
        terminal,
        &wire::FrameHeader::default(),
        "provider-operation/1",
        1,
    )
    .expect("terminal");
    assert!(event.is_terminal());
}

#[test]
fn tool_usage_and_terminal_payloads_fail_closed_when_semantically_corrupt() {
    let tool = wire::ProviderToolCall {
        identity: Some(identity()),
        operation_id: "provider-operation/1".into(),
        event_sequence: 1,
        tool_use_id: "tool-use/1".into(),
        capability_name: "filesystem.read".into(),
        encoded_json_arguments: br#"{"path":"README.md"}"#.to_vec(),
        ..wire::ProviderToolCall::default()
    };
    let mut valid_tool = tool.clone();
    valid_tool.arguments_sha256 = Sha256::digest(&valid_tool.encoded_json_arguments).to_vec();
    validate_stream_event(
        wire::frame_payload::Body::ProviderToolCall(valid_tool),
        &wire::FrameHeader::default(),
        "provider-operation/1",
        1,
    )
    .expect("valid tool call");
    assert!(matches!(
        validate_stream_event(
            wire::frame_payload::Body::ProviderToolCall(tool),
            &wire::FrameHeader::default(),
            "provider-operation/1",
            1,
        ),
        Err(ProviderDataError::UnexpectedPayload(_))
    ));

    let usage = wire::ProviderUsageEvent {
        identity: Some(identity()),
        operation_id: "provider-operation/1".into(),
        event_sequence: 1,
        usage: Some(wire::ProviderUsage {
            input_tokens: 3,
            cache_read_input_tokens: Some(4),
            ..wire::ProviderUsage::default()
        }),
    };
    assert!(
        validate_stream_event(
            wire::frame_payload::Body::ProviderUsage(usage),
            &wire::FrameHeader::default(),
            "provider-operation/1",
            1,
        )
        .is_err()
    );

    let terminal = wire::ProviderTerminal {
        identity: Some(identity()),
        operation_id: "provider-operation/1".into(),
        event_sequence: 1,
        classification: wire::ProviderTerminalClassification::Completed as i32,
        reason_code: "provider_completed".into(),
        completed_at_unix_ms: 10,
        ..wire::ProviderTerminal::default()
    };
    assert!(
        validate_stream_event(
            wire::frame_payload::Body::ProviderTerminal(terminal),
            &wire::FrameHeader::default(),
            "provider-operation/1",
            1,
        )
        .is_err()
    );
}

#[tokio::test]
async fn capability_prepare_receives_an_exact_correlated_decision_over_data() {
    let identity = identity();
    let (runner, mut host) = established_data_duplex(&identity).expect("test data peers");
    let input = br#"{"path":"README.md"}"#.to_vec();
    let input_sha256 = Sha256::digest(&input).to_vec();
    let prepare = wire::CapabilityPrepare {
        identity: Some(identity.clone()),
        runtime_instance_id: "runtime/capability-duplex".into(),
        operation_id: "capability-operation/1".into(),
        provider_operation_id: "provider-operation/1".into(),
        tool_use_id: "tool-use/1".into(),
        capability_id: "native.read_file".into(),
        capability_version: "1".into(),
        execution_class: wire::CapabilityExecutionClass::NativeRead as i32,
        encoded_json_input: input,
        input_sha256,
        capability_set_sha256: vec![7; 32],
        idempotency_key: "capability-prepare/1".into(),
        deadline_at_unix_ms: 1_000,
        ..wire::CapabilityPrepare::default()
    };
    let mut client =
        ProviderDataClient::new(runner, identity.clone(), "runtime/capability-duplex".into());
    let timing = ProviderDataTiming {
        hard_deadline: physical_deadline(),
        replay_write_timeout: Duration::from_secs(1),
    };
    let clock = || 10;
    let host_work = async move {
        let FrameReceiveOutcome::Pending(mut pending) = host
            .begin_receive(
                physical_deadline(),
                physical_deadline(),
                Duration::from_secs(1),
                || 10,
            )
            .await
            .expect("capability prepare")
        else {
            panic!("fresh CapabilityPrepare expected");
        };
        let (body, _) = pending.take_body_and_digest().expect("prepare body");
        let wire::frame_payload::Body::CapabilityPrepare(received) = body else {
            panic!("CapabilityPrepare expected");
        };
        assert_eq!(received.operation_id, "capability-operation/1");
        assert_eq!(received.tool_use_id, "tool-use/1");
        let update = wire::FramePayload {
            body: Some(wire::frame_payload::Body::CapabilityUpdate(
                wire::CapabilityUpdate {
                    identity: Some(identity),
                    runtime_instance_id: "runtime/capability-duplex".into(),
                    operation_id: received.operation_id,
                    tool_use_id: received.tool_use_id,
                    decision: Some(wire::capability_update::Decision::Rejected(
                        wire::CapabilityRejected {
                            decision_id: "decision/1".into(),
                            reason_code: "policy_denied".into(),
                            policy_version: "policy/v1".into(),
                            decided_at_unix_ms: 10,
                        },
                    )),
                },
            )),
        };
        host.commit_response(*pending, &update, 1_000, physical_deadline(), || 10)
            .await
            .expect("capability decision response");
    };
    let ((), result) = tokio::join!(
        host_work,
        client.prepare_capability(prepare, timing, &clock),
    );
    let update = result.expect("correlated capability decision");
    assert!(matches!(
        update.decision,
        Some(wire::capability_update::Decision::Rejected(ref rejection))
            if rejection.reason_code == "policy_denied"
    ));
}

fn physical_deadline() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
