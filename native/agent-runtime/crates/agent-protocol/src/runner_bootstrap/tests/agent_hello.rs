use std::io::{self, Cursor, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex};

use prost::Message;

use crate::frame::{
    AsyncBootstrapAttemptChannel, BootstrapAttemptChannel, CONTROL_FRAME_MAX_BYTES, FrameDirection,
    FrameValidationError, frame_payload_sha256, validate_attempt_frame,
};
use crate::framing::{DelimitedFrameChannel, DelimitedFrameCodec};
use crate::generated::v1 as wire;
use crate::identity::ConnectionId;
use crate::version::ProtocolVersion;
use crate::wire_identity::identity_from_wire;
use tokio::io::AsyncReadExt;
use tokio::time::{Duration, Instant};

use super::super::decode_runner_launch_handoff;
use super::support;
use crate::runner_bootstrap::secrets::{SecretField, capture_scrub_audit};

#[derive(Clone, Default)]
struct SharedWriter(Arc<Mutex<Vec<u8>>>);

impl Write for SharedWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().expect("writer lock").extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct FailWriter;

impl Write for FailWriter {
    fn write(&mut self, _bytes: &[u8]) -> io::Result<usize> {
        Err(io::Error::other("injected write failure"))
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct PanicWriter;

impl Write for PanicWriter {
    fn write(&mut self, _bytes: &[u8]) -> io::Result<usize> {
        panic!("injected writer panic")
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn owned_draft_commits_once_and_scrubs_nonce_on_success() {
    let writer = SharedWriter::default();
    let output = writer.clone();
    let pending = nonce().prepare_agent_hello(draft()).expect("empty draft");
    let mut channel = channel(writer);

    let (result, audit) = capture_scrub_audit(|| pending.commit(&mut channel, || 1_000));

    result.expect("AgentHello commit");
    assert!(!output.0.lock().expect("writer lock").is_empty());
    assert_nonce_scrubbed(&audit);
}

#[test]
fn write_failure_panic_and_drop_scrub_the_owned_nonce() {
    let mut failure_channel = channel(FailWriter);
    let pending = nonce().prepare_agent_hello(draft()).expect("empty draft");
    let (failed, failure_audit) =
        capture_scrub_audit(|| pending.commit(&mut failure_channel, || 1_000));
    assert!(failed.is_err());
    assert_nonce_scrubbed(&failure_audit);

    let mut panic_channel = channel(PanicWriter);
    let pending = nonce().prepare_agent_hello(draft()).expect("empty draft");
    let (panicked, panic_audit) = capture_scrub_audit(|| {
        catch_unwind(AssertUnwindSafe(|| {
            let _ = pending.commit(&mut panic_channel, || 1_000);
        }))
    });
    assert!(panicked.is_err());
    assert_nonce_scrubbed(&panic_audit);

    let pending = nonce().prepare_agent_hello(draft()).expect("empty draft");
    let ((), drop_audit) = capture_scrub_audit(|| drop(pending));
    assert_nonce_scrubbed(&drop_audit);
}

#[test]
fn every_early_send_rejection_scrubs_the_owned_nonce() {
    let mut wrong_direction = channel_with_direction(FailWriter, FrameDirection::RunnerToHost);
    let pending = nonce().prepare_agent_hello(draft()).expect("empty draft");
    let (wrong, wrong_audit) =
        capture_scrub_audit(|| pending.commit(&mut wrong_direction, || 1_000));
    assert!(wrong.is_err());
    assert_nonce_scrubbed(&wrong_audit);

    let mut invalid_draft = draft();
    invalid_draft.supported_protocols = None;
    let pending = nonce()
        .prepare_agent_hello(invalid_draft)
        .expect("nonce remains empty");
    let mut invalid_protocol = channel(FailWriter);
    let (invalid, invalid_audit) =
        capture_scrub_audit(|| pending.commit(&mut invalid_protocol, || 1_000));
    assert!(invalid.is_err());
    assert_nonce_scrubbed(&invalid_audit);

    let writer = SharedWriter::default();
    let mut repeated = channel(writer);
    nonce()
        .prepare_agent_hello(draft())
        .expect("empty draft")
        .commit(&mut repeated, || 1_000)
        .expect("first Hello");
    let pending = nonce().prepare_agent_hello(draft()).expect("empty draft");
    let (duplicate, duplicate_audit) =
        capture_scrub_audit(|| pending.commit(&mut repeated, || 1_000));
    assert!(duplicate.is_err());
    assert_nonce_scrubbed(&duplicate_audit);
}

#[tokio::test]
async fn never_polled_async_commit_scrubs_nonce_closes_peer_and_is_send() {
    let pending = nonce().prepare_agent_hello(draft()).expect("empty draft");
    let (mut channel, mut peer) = async_channel();

    let ((), audit) = capture_scrub_audit(|| {
        let never_polled = pending.commit_async(
            &mut channel,
            Instant::now() + Duration::from_secs(1),
            || 1_000,
        );
        assert_send(&never_polled);
        drop(never_polled);
    });

    assert_nonce_scrubbed(&audit);
    let mut byte = [0_u8; 1];
    assert_eq!(peer.read(&mut byte).await.expect("peer read"), 0);
}

#[test]
fn draft_with_nonce_is_rejected_without_a_public_recovery_path() {
    let mut invalid = draft();
    invalid.launch_nonce = vec![4; 32];

    assert!(nonce().prepare_agent_hello(invalid).is_err());
}

#[test]
fn malformed_outer_payload_scrubs_a_partially_decoded_nonce() {
    let handoff = support::windows_handoff();
    let identity = handoff.identity.expect("identity");
    let connection_id = handoff.endpoints[0].connection_id.clone();
    let mut encoded_payload = wire::FramePayload {
        body: Some(wire::frame_payload::Body::AgentHello(wire::AgentHello {
            launch_nonce: vec![0x5a; 32],
            ..Default::default()
        })),
    }
    .encode_to_vec();
    encoded_payload.push(0x80);
    let frame = wire::Frame {
        header: Some(wire::FrameHeader {
            protocol_version: ProtocolVersion::new(1, 1).to_wire(),
            connection_id,
            message_id: "malformed-late".into(),
            session_id: identity.session_id,
            command_id: identity.command_id,
            agent_run_id: identity.agent_run_id,
            attempt_id: identity.attempt_id,
            executor_owner_id: identity.executor_owner_id,
            fencing_epoch: identity.fencing_epoch,
            correlation_id: identity.correlation_id,
            stream_seq: 1,
            sent_at_unix_ms: 1,
            payload_sha256: frame_payload_sha256(&encoded_payload).to_vec(),
            root_agent_run_id: identity.root_agent_run_id,
            owner_agent_run_id: identity.owner_agent_run_id,
            parent_agent_run_id: identity.parent_agent_run_id,
            ..wire::FrameHeader::default()
        }),
        channel: wire::TransportChannel::Control as i32,
        encoded_payload,
    }
    .encode_to_vec();

    let (result, audit) =
        capture_scrub_audit(|| validate_attempt_frame(&frame, wire::TransportChannel::Control));

    assert!(matches!(
        result,
        Err(FrameValidationError::MalformedPayload(_))
    ));
    assert_nonce_scrubbed(&audit);
}

fn nonce() -> super::super::PendingRunnerLaunchNonce {
    let mut handoff =
        decode_runner_launch_handoff(support::windows_handoff().encode_to_vec()).expect("handoff");
    handoff.take_launch_nonce().expect("launch nonce")
}

fn draft() -> wire::AgentHello {
    wire::AgentHello {
        supported_protocols: Some(wire::ProtocolVersionRange {
            minimum: Some(wire::ProtocolVersion { major: 1, minor: 0 }),
            maximum: Some(wire::ProtocolVersion { major: 1, minor: 1 }),
        }),
        ..Default::default()
    }
}

fn channel<W: Write>(writer: W) -> BootstrapAttemptChannel<Cursor<Vec<u8>>, W> {
    channel_with_direction(writer, FrameDirection::HostToRunner)
}

fn channel_with_direction<W: Write>(
    writer: W,
    direction: FrameDirection,
) -> BootstrapAttemptChannel<Cursor<Vec<u8>>, W> {
    let handoff = support::windows_handoff();
    let identity =
        identity_from_wire(handoff.identity.as_ref().expect("identity")).expect("identity");
    let connection =
        ConnectionId::new(handoff.endpoints[0].connection_id.clone()).expect("connection");
    let cap = u32::try_from(CONTROL_FRAME_MAX_BYTES).expect("control cap");
    let transport = DelimitedFrameChannel::new(
        DelimitedFrameCodec::new(cap).expect("codec"),
        Cursor::new(Vec::new()),
        writer,
    );
    BootstrapAttemptChannel::new(
        transport,
        identity,
        connection,
        direction,
        CONTROL_FRAME_MAX_BYTES,
    )
    .expect("bootstrap channel")
}

fn async_channel() -> (
    AsyncBootstrapAttemptChannel<tokio::io::DuplexStream>,
    tokio::io::DuplexStream,
) {
    let handoff = support::windows_handoff();
    let identity =
        identity_from_wire(handoff.identity.as_ref().expect("identity")).expect("identity");
    let connection =
        ConnectionId::new(handoff.endpoints[0].connection_id.clone()).expect("connection");
    let (stream, peer) = tokio::io::duplex(4 * 1024);
    (
        AsyncBootstrapAttemptChannel::new(stream, identity, connection, CONTROL_FRAME_MAX_BYTES)
            .expect("async bootstrap channel"),
        peer,
    )
}

fn assert_send<T: Send>(_: &T) {}

fn assert_nonce_scrubbed(audit: &[crate::runner_bootstrap::secrets::ScrubAudit]) {
    assert!(audit.iter().any(|entry| {
        entry.field == SecretField::AgentHelloNonce && entry.length == 32 && entry.all_zero
    }));
}
