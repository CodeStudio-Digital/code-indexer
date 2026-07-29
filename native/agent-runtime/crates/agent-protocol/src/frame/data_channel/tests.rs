use std::time::Duration;

use prost::Message;
use tokio::io::{DuplexStream, duplex};
use tokio::time::Instant;

use super::*;
use crate::frame::{DATA_FRAME_MAX_BYTES, encode_attempt_frame};
use crate::framing::DelimitedFrameCodec;
use crate::framing::asynchronous::AsyncDelimitedFrameChannel;
use crate::generated::v1 as wire;
use crate::identity::{AttemptIdentity, ConnectionId, RuntimeInstanceId};
use crate::runner_bootstrap::RunnerEndpointTokenVerifier;
use crate::version::ProtocolVersion;
use crate::wire_identity::{identity_from_wire, identity_to_wire};

const CONNECTION: &str = "connection:data/7";
const RUNTIME: &str = "runtime:opaque/7";
const TOKEN: [u8; 16] = [0x22; 16];
const HANDOFF_DIGEST: [u8; 32] = [0x44; 32];

fn wire_identity() -> wire::AttemptIdentity {
    wire::AttemptIdentity {
        session_id: "11111111-1111-4111-8111-111111111111".into(),
        command_id: "22222222-2222-4222-8222-222222222222".into(),
        agent_run_id: "33333333-3333-4333-8333-333333333333".into(),
        attempt_id: "44444444-4444-4444-8444-444444444444".into(),
        executor_owner_id: "host:desktop".into(),
        fencing_epoch: 7,
        correlation_id: "55555555-5555-4555-8555-555555555555".into(),
        root_agent_run_id: "33333333-3333-4333-8333-333333333333".into(),
        owner_agent_run_id: Some("77777777-7777-4777-8777-777777777777".into()),
        parent_agent_run_id: None,
    }
}

fn identity() -> AttemptIdentity {
    identity_from_wire(&wire_identity()).expect("identity")
}

fn limits() -> DataChannelLimits {
    DataChannelLimits::new(wire::FrameLimits {
        max_frame_bytes: DATA_FRAME_MAX_BYTES as u64,
        max_chunk_bytes: 900 * 1_024,
        max_in_flight_frames: 1,
        max_in_flight_bytes: DATA_FRAME_MAX_BYTES as u64,
        read_timeout_ms: 30_000,
        write_timeout_ms: 30_000,
        transport_crc32c: false,
    })
    .expect("limits")
}

fn authority_for(
    kind: wire::AttemptEndpointKind,
    connection: &str,
) -> Result<RunnerDataBindAuthority, DataChannelError> {
    RunnerDataBindAuthority::new(
        identity(),
        ConnectionId::new(CONNECTION).expect("connection"),
        ProtocolVersion::new(1, 1),
        RuntimeInstanceId::new(RUNTIME).expect("runtime"),
        &HANDOFF_DIGEST,
        RunnerEndpointTokenVerifier::new_for_test(kind, connection, &TOKEN, HANDOFF_DIGEST),
        limits(),
    )
}

fn header(message_id: &str) -> wire::FrameHeader {
    let identity = identity_to_wire(&identity());
    wire::FrameHeader {
        protocol_version: ProtocolVersion::new(1, 1).to_wire(),
        connection_id: CONNECTION.into(),
        message_id: message_id.into(),
        session_id: identity.session_id,
        command_id: identity.command_id,
        agent_run_id: identity.agent_run_id,
        attempt_id: identity.attempt_id,
        executor_owner_id: identity.executor_owner_id,
        fencing_epoch: identity.fencing_epoch,
        correlation_id: identity.correlation_id,
        stream_seq: 1,
        sent_at_unix_ms: 10,
        deadline_at_unix_ms: Some(1_000),
        root_agent_run_id: identity.root_agent_run_id,
        owner_agent_run_id: identity.owner_agent_run_id,
        parent_agent_run_id: identity.parent_agent_run_id,
        ..wire::FrameHeader::default()
    }
}

fn encoded_body(body: wire::frame_payload::Body, message_id: &str) -> Vec<u8> {
    encode_attempt_frame(
        header(message_id),
        wire::TransportChannel::Data,
        &wire::FramePayload { body: Some(body) },
        DATA_FRAME_MAX_BYTES,
    )
    .expect("frame")
}

fn bind_frame(token: Vec<u8>) -> Vec<u8> {
    encoded_body(
        wire::frame_payload::Body::BindAttemptChannel(wire::BindAttemptChannel {
            identity: Some(wire_identity()),
            runtime_instance_id: RUNTIME.into(),
            channel: wire::TransportChannel::Data as i32,
            connection_session_token: token,
        }),
        "bind-message",
    )
}

fn hydration_before_bind_frame() -> Vec<u8> {
    encoded_body(
        wire::frame_payload::Body::HydrationManifest(wire::HydrationManifest {
            identity: Some(wire_identity()),
            transfer_id: "transfer-1".into(),
            items: Vec::new(),
            total_payload_bytes: 0,
            max_chunk_bytes: 1,
        }),
        "early-manifest",
    )
}

fn physical_deadline() -> Instant {
    Instant::now() + Duration::from_secs(5)
}

fn bind_deadlines() -> DataBindDeadlines {
    DataBindDeadlines {
        read: physical_deadline(),
        replay_hard: physical_deadline(),
        replay_write_timeout: Duration::from_secs(1),
        write: physical_deadline(),
        semantic_at_unix_ms: 1_000,
    }
}

fn host_channel(stream: DuplexStream) -> AsyncDelimitedFrameChannel<DuplexStream> {
    AsyncDelimitedFrameChannel::new(
        DelimitedFrameCodec::new(u32::try_from(DATA_FRAME_MAX_BYTES).expect("u32 cap"))
            .expect("codec"),
        stream,
    )
}

#[test]
fn data_limits_require_bounded_stop_and_wait_credit() {
    let mut invalid = *limits().as_wire();
    invalid.max_in_flight_frames = 2;
    assert!(matches!(
        DataChannelLimits::new(invalid),
        Err(DataChannelError::InvalidLimits(_))
    ));

    let mut invalid = *limits().as_wire();
    invalid.max_chunk_bytes = invalid.max_frame_bytes;
    assert!(matches!(
        DataChannelLimits::new(invalid),
        Err(DataChannelError::InvalidLimits(_))
    ));
}

#[test]
fn authority_rejects_a_control_or_foreign_endpoint_verifier() {
    assert!(matches!(
        authority_for(wire::AttemptEndpointKind::Control, CONNECTION),
        Err(DataChannelError::InvalidAuthority(_))
    ));
    assert!(matches!(
        authority_for(wire::AttemptEndpointKind::Data, "connection:other"),
        Err(DataChannelError::InvalidAuthority(_))
    ));
}

#[tokio::test]
async fn exact_host_bind_commits_bound_response_and_unlocks_data_stream() {
    let (runner, host) = duplex(2 * DATA_FRAME_MAX_BYTES);
    let pending = authority_for(wire::AttemptEndpointKind::Data, CONNECTION)
        .expect("authority")
        .attach(runner)
        .expect("pending");
    let host_task = tokio::spawn(async move {
        let mut host = host_channel(host);
        host.send(&bind_frame(TOKEN.to_vec()), physical_deadline())
            .await
            .expect("send bind");
        let response = host
            .receive(physical_deadline())
            .await
            .expect("receive bound");
        let frame = wire::Frame::decode(response.as_slice()).expect("frame");
        assert_eq!(frame.channel, wire::TransportChannel::Data as i32);
        let payload =
            wire::FramePayload::decode(frame.encoded_payload.as_slice()).expect("payload");
        let Some(wire::frame_payload::Body::AttemptChannelBound(bound)) = payload.body else {
            panic!("expected AttemptChannelBound")
        };
        assert_eq!(bound.runtime_instance_id, RUNTIME);
        assert_eq!(bound.channel, wire::TransportChannel::Data as i32);
        assert_eq!(bound.effective_limits, Some(*limits().as_wire()));
    });
    let mut now = 99_i64;
    let bound = pending
        .bind(bind_deadlines(), || {
            now += 1;
            now
        })
        .await
        .expect("bound");

    assert_eq!(bound.limits(), &limits());
    host_task.await.expect("host task");
}

#[tokio::test]
async fn wrong_token_or_hydration_before_bind_fails_closed() {
    for frame in [bind_frame(vec![0x99; 16]), hydration_before_bind_frame()] {
        let (runner, host) = duplex(2 * DATA_FRAME_MAX_BYTES);
        let pending = authority_for(wire::AttemptEndpointKind::Data, CONNECTION)
            .expect("authority")
            .attach(runner)
            .expect("pending");
        let host_task = tokio::spawn(async move {
            host_channel(host)
                .send(&frame, physical_deadline())
                .await
                .expect("send candidate");
        });
        let mut now = 99_i64;
        assert!(
            pending
                .bind(bind_deadlines(), || {
                    now += 1;
                    now
                })
                .await
                .is_err()
        );
        host_task.await.expect("host task");
    }
}
