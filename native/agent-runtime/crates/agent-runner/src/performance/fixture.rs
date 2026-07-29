use std::io::Cursor;
use std::time::{SystemTime, UNIX_EPOCH};

use agent_protocol::frame::{CONTROL_FRAME_MAX_BYTES, encode_attempt_frame};
use agent_protocol::framing::DelimitedFrameCodec;
use agent_protocol::generated::v1 as wire;
use agent_protocol::runner_bootstrap::{PendingRunnerLaunchNonce, decode_runner_launch_handoff};
use agent_protocol::semantic_hash::semantic_sha256;
use agent_protocol::version::ProtocolVersion;
use prost::Message;

use crate::control::RunnerLaunchContext;

mod launch;
mod spec;

pub(super) use spec::{containment_report, resource_budget};
use spec::{host_hello, required_snapshots, valid_spec};

const CONNECTION_ID: &str = "perf-control-connection";
const CONTRACT_VERSION: &str = "contract-v1";
const RUNTIME_ID: &str = "perf-runtime";
const LAUNCH_NONCE: &[u8] = &[7; 32];
const CONTROL_TOKEN: &[u8] = &[9; 32];
const ACTIVATION_NONCE: &[u8] = b"performance-activation-nonce";

/// Produces the exact bounded `HostHello` and `PrepareAttempt` input stream.
///
/// # Errors
///
/// Rejects an invalid deadline or any frame/transport encoding failure.
pub fn prepared_probe_host_input(deadline_at_unix_ms: i64) -> Result<Vec<u8>, String> {
    let spec_deadline = deadline_at_unix_ms
        .checked_sub(500)
        .ok_or_else(|| "probe deadline underflow".to_owned())?;
    if spec_deadline <= unix_ms()? {
        return Err("probe deadline is not in the future".into());
    }
    let spec = valid_spec(spec_deadline);
    let encoded_spec = spec.encode_to_vec();
    let spec_sha256 = semantic_sha256(
        "codestudio.agent.v1.ResolvedAttemptSpec",
        spec.schema_version,
        &encoded_spec,
    )
    .map_err(|error| format!("cannot hash probe spec: {error}"))?;
    let prepare = wire::PrepareAttempt {
        identity: Some(identity()),
        encoded_spec,
        expected_spec_sha256: spec_sha256.to_vec(),
        expected_snapshots: required_snapshots(&spec),
        idempotency_key: "perf-prepare".into(),
        spec_schema_version: spec.schema_version,
    };
    let frames = [
        encode(
            wire::frame_payload::Body::HostHello(host_hello(
                CONNECTION_ID,
                CONTRACT_VERSION,
                CONTROL_TOKEN,
            )),
            "perf-host-hello",
            1,
            spec_deadline,
        )?,
        encode(
            wire::frame_payload::Body::PrepareAttempt(prepare),
            "perf-prepare",
            2,
            spec_deadline,
        )?,
    ];
    let maximum = u32::try_from(CONTROL_FRAME_MAX_BYTES).map_err(|_| "control cap exceeds u32")?;
    let codec = DelimitedFrameCodec::new(maximum).map_err(|error| error.to_string())?;
    let mut output = Cursor::new(Vec::new());
    for frame in frames {
        codec
            .write_raw(&mut output, &frame)
            .map_err(|error| format!("cannot frame probe input: {error}"))?;
    }
    Ok(output.into_inner())
}

pub(super) fn launch_authority(
    deadline_at_unix_ms: i64,
) -> Result<(RunnerLaunchContext, PendingRunnerLaunchNonce), String> {
    let mut handoff =
        decode_runner_launch_handoff(launch::launch_handoff(deadline_at_unix_ms).encode_to_vec())
            .map_err(|error| format!("cannot validate probe handoff: {error}"))?;
    let verifier = handoff
        .take_endpoint_token_verifier(wire::AttemptEndpointKind::Control)
        .map_err(|error| format!("cannot take probe control verifier: {error}"))?;
    let nonce = handoff
        .take_launch_nonce()
        .ok_or_else(|| "probe launch nonce is missing".to_owned())?;
    let context = RunnerLaunchContext::from_validated_handoff(&handoff, verifier)
        .map_err(|error| format!("cannot derive probe launch context: {error}"))?;
    Ok((context, nonce))
}

pub(super) fn agent_hello_draft() -> wire::AgentHello {
    wire::AgentHello {
        supported_protocols: Some(wire::ProtocolVersionRange {
            minimum: Some(wire::ProtocolVersion { major: 1, minor: 1 }),
            maximum: Some(wire::ProtocolVersion { major: 1, minor: 1 }),
        }),
        contract_version: CONTRACT_VERSION.into(),
        contract_schema_version: 1,
        provenance: Some(wire::RuntimeProvenance {
            build_id: "performance-harness".into(),
            source_commit: "local-release".into(),
            binary_sha256: vec![3; 32],
            runtime_instance_id: RUNTIME_ID.into(),
            pid: std::process::id(),
            operating_system: std::env::consts::OS.into(),
            architecture: std::env::consts::ARCH.into(),
        }),
        launch_nonce: Vec::new(),
        containment: containment_report().capabilities,
        supported_feature_bits: 0,
        native_capabilities: Vec::new(),
    }
}

fn encode(
    body: wire::frame_payload::Body,
    message_id: &str,
    sequence: u64,
    deadline_at_unix_ms: i64,
) -> Result<Vec<u8>, String> {
    encode_attempt_frame(
        frame_header(message_id, sequence, deadline_at_unix_ms),
        wire::TransportChannel::Control,
        &wire::FramePayload { body: Some(body) },
        CONTROL_FRAME_MAX_BYTES,
    )
    .map_err(|error| format!("cannot encode probe control frame: {error}"))
}

fn frame_header(message_id: &str, stream_seq: u64, deadline_at_unix_ms: i64) -> wire::FrameHeader {
    let identity = identity();
    wire::FrameHeader {
        protocol_version: ProtocolVersion::new(1, 1).to_wire(),
        connection_id: CONNECTION_ID.into(),
        message_id: message_id.into(),
        session_id: identity.session_id,
        command_id: identity.command_id,
        agent_run_id: identity.agent_run_id,
        attempt_id: identity.attempt_id,
        executor_owner_id: identity.executor_owner_id,
        fencing_epoch: identity.fencing_epoch,
        correlation_id: identity.correlation_id,
        stream_seq,
        sent_at_unix_ms: unix_ms().unwrap_or(1),
        deadline_at_unix_ms: Some(deadline_at_unix_ms),
        root_agent_run_id: identity.root_agent_run_id,
        owner_agent_run_id: None,
        parent_agent_run_id: None,
        ..wire::FrameHeader::default()
    }
}

pub(super) fn identity() -> wire::AttemptIdentity {
    wire::AttemptIdentity {
        session_id: "11111111-1111-4111-8111-111111111111".into(),
        command_id: "22222222-2222-4222-8222-222222222222".into(),
        agent_run_id: "33333333-3333-4333-8333-333333333333".into(),
        attempt_id: "44444444-4444-4444-8444-444444444444".into(),
        executor_owner_id: "performance-runner".into(),
        fencing_epoch: 7,
        correlation_id: "55555555-5555-4555-8555-555555555555".into(),
        root_agent_run_id: "33333333-3333-4333-8333-333333333333".into(),
        owner_agent_run_id: None,
        parent_agent_run_id: None,
    }
}

fn unix_ms() -> Result<i64, String> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is before Unix epoch")?;
    i64::try_from(elapsed.as_millis()).map_err(|_| "system clock exceeds i64".into())
}
