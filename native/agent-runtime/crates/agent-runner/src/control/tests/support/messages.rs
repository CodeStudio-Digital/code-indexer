use std::io::Cursor;

use agent_protocol::frame::{CONTROL_FRAME_MAX_BYTES, encode_attempt_frame};
use agent_protocol::framing::{DelimitedFrameCodec, FramingError};
use agent_protocol::generated::v1 as wire;
use agent_protocol::semantic_hash::semantic_sha256;
use prost::Message;

use super::{
    ACTIVATION_NONCE, AGENT_RUN_VERSION, ATTEMPT_VERSION, SPEC_DEADLINE, frame_header, host_hello,
    required_snapshots, resource_budget, snapshot, wire_identity,
};

mod termination;

pub(in crate::control::tests) use termination::{
    CANCEL_GRACE_DEADLINE, FENCED_AT, cancel_frame, cancel_frame_with, fence_frame,
    fence_frame_with,
};

const SPEC_SCHEMA_ID: &str = "codestudio.agent.v1.ResolvedAttemptSpec";

pub(in crate::control::tests) fn attempt_frames() -> Vec<Vec<u8>> {
    vec![
        prepare_frame("prepare-1", 2),
        activate_frame("activate-1", 3),
    ]
}

pub(in crate::control::tests) fn prepare_frame(message_id: &str, stream_seq: u64) -> Vec<u8> {
    let spec = valid_spec();
    let encoded_spec = spec.encode_to_vec();
    let spec_sha256 =
        semantic_sha256(SPEC_SCHEMA_ID, spec.schema_version, &encoded_spec).expect("spec hash");
    let prepare = wire::PrepareAttempt {
        identity: Some(wire_identity()),
        encoded_spec,
        expected_spec_sha256: spec_sha256.to_vec(),
        expected_snapshots: required_snapshots(&spec),
        idempotency_key: "prepare-key".to_owned(),
        spec_schema_version: spec.schema_version,
    };
    encoded_control(
        wire::frame_payload::Body::PrepareAttempt(prepare),
        message_id,
        stream_seq,
        SPEC_DEADLINE,
    )
}

pub(in crate::control::tests) fn activate_frame_with_deadline(
    message_id: &str,
    stream_seq: u64,
    deadline: i64,
) -> Vec<u8> {
    activate_frame_with(message_id, stream_seq, deadline, |_| {})
}

pub(in crate::control::tests) fn activate_frame_with(
    message_id: &str,
    stream_seq: u64,
    deadline: i64,
    update: impl FnOnce(&mut wire::ActivateAttempt),
) -> Vec<u8> {
    let spec = valid_spec();
    let encoded_spec = spec.encode_to_vec();
    let spec_sha256 =
        semantic_sha256(SPEC_SCHEMA_ID, spec.schema_version, &encoded_spec).expect("spec hash");
    let mut activate = wire::ActivateAttempt {
        identity: Some(wire_identity()),
        agent_run_version: AGENT_RUN_VERSION,
        attempt_version: ATTEMPT_VERSION,
        deadline_at_unix_ms: deadline,
        activation_nonce: ACTIVATION_NONCE.to_vec(),
        spec_sha256: spec_sha256.to_vec(),
        idempotency_key: "activate-key".to_owned(),
    };
    update(&mut activate);
    encoded_control(
        wire::frame_payload::Body::ActivateAttempt(activate),
        message_id,
        stream_seq,
        deadline,
    )
}

fn activate_frame(message_id: &str, stream_seq: u64) -> Vec<u8> {
    activate_frame_with_deadline(message_id, stream_seq, SPEC_DEADLINE)
}

pub(in crate::control::tests) fn host_hello_frame() -> Vec<u8> {
    host_hello_frame_for_connection(super::CONNECTION_ID)
}

pub(in crate::control::tests) fn host_hello_frame_for_connection(connection_id: &str) -> Vec<u8> {
    host_hello_frame_with(|hello| hello.connection_id = connection_id.to_owned())
}

pub(in crate::control::tests) fn host_hello_frame_with(
    update: impl FnOnce(&mut wire::HostHello),
) -> Vec<u8> {
    let mut hello = host_hello();
    update(&mut hello);
    let mut header = frame_header("host-hello-1", 1, SPEC_DEADLINE);
    header.connection_id.clone_from(&hello.connection_id);
    encode_attempt_frame(
        header,
        wire::TransportChannel::Control,
        &wire::FramePayload {
            body: Some(wire::frame_payload::Body::HostHello(hello)),
        },
        CONTROL_FRAME_MAX_BYTES,
    )
    .expect("valid HostHello fixture")
}

pub(in crate::control::tests) fn decode_written_frames(
    bytes: &[u8],
) -> Result<Vec<wire::Frame>, FramingError> {
    decode_written_raw_frames(bytes)?
        .into_iter()
        .map(|encoded| {
            wire::Frame::decode(encoded.as_slice()).map_err(FramingError::MalformedFrame)
        })
        .collect()
}

pub(in crate::control::tests) fn decode_written_raw_frames(
    bytes: &[u8],
) -> Result<Vec<Vec<u8>>, FramingError> {
    let maximum = u32::try_from(CONTROL_FRAME_MAX_BYTES).expect("control cap fits u32");
    let codec = DelimitedFrameCodec::new(maximum)?;
    let mut reader = Cursor::new(bytes);
    let mut frames = Vec::new();
    while let Some(encoded) = codec.read_raw(&mut reader)? {
        frames.push(encoded);
    }
    Ok(frames)
}

pub(super) fn valid_spec() -> wire::ResolvedAttemptSpec {
    wire::ResolvedAttemptSpec {
        schema_version: 1,
        spec_version: 4,
        identity: Some(wire_identity()),
        ordinal: 1,
        trigger: wire::AttemptTrigger::Initial as i32,
        spawn_depth: 0,
        role: "coder".to_owned(),
        agent_definition_id: "native-coder".to_owned(),
        task: Some(wire::TaskInput {
            body: Some(wire::task_input::Body::InlineUtf8(
                "Implement the requested change".to_owned(),
            )),
            attachments: Vec::new(),
        }),
        provider_binding: Some(wire::ProviderBinding {
            requested_provider: Some("openai".to_owned()),
            requested_model: Some("gpt-5".to_owned()),
            effective_provider: "openai".to_owned(),
            effective_model: "gpt-5".to_owned(),
            ..wire::ProviderBinding::default()
        }),
        downgrade_reasons: Vec::new(),
        wait_mode: wire::AgentRunWaitMode::Foreground as i32,
        run_tree_budget: Some(wire::AgentRunBudget {
            max_turns: Some(20),
            max_wall_ms: Some(20_000),
            max_input_tokens: Some(100_000),
            max_output_tokens: Some(50_000),
            max_tool_calls: Some(100),
            max_agents: Some(8),
            max_depth: Some(4),
            max_cost_micros: Some(10_000_000),
            cost_currency: Some("USD".to_owned()),
        }),
        verifier_policy_snapshot: Some(snapshot("verifier")),
        capability_set_snapshot: Some(snapshot("capabilities")),
        environment_snapshot: Some(snapshot("environment")),
        workspace_lease_snapshot: Some(snapshot("workspace-lease")),
        workspace_lease_fencing_epoch: 7,
        policy_snapshot: Some(snapshot("policy")),
        preset_snapshot: Some(snapshot("preset")),
        checkpoint_input: None,
        transcript_input: None,
        resource_budget: Some(resource_budget()),
        deadline_at_unix_ms: SPEC_DEADLINE,
        agent_definition_snapshot: Some(snapshot("agent-definition")),
    }
}

fn encoded_control(
    body: wire::frame_payload::Body,
    message_id: &str,
    stream_seq: u64,
    deadline: i64,
) -> Vec<u8> {
    encode_attempt_frame(
        frame_header(message_id, stream_seq, deadline),
        wire::TransportChannel::Control,
        &wire::FramePayload { body: Some(body) },
        CONTROL_FRAME_MAX_BYTES,
    )
    .expect("valid fixture frame")
}
