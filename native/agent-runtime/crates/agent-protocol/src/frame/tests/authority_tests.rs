use std::cell::{Cell, RefCell};
use std::io::{self, Cursor, Read, Write};
use std::rc::Rc;

use prost::Message;

use super::super::bootstrap::BootstrapReceiver;
use super::*;
use crate::framing::{DelimitedFrameChannel, DelimitedFrameCodec};
use crate::identity::ConnectionId;
use crate::runner_bootstrap::{SecretField, capture_scrub_audit};
use crate::wire_identity::{MAX_WIRE_IDENTIFIER_BYTES, identity_from_wire};

const TEST_REPLAY_BYTES: usize = CONTROL_FRAME_MAX_BYTES * 4;

fn connection() -> ConnectionId {
    ConnectionId::new("connection").expect("connection")
}

pub(super) fn bytes_with(
    body: wire::frame_payload::Body,
    message_id: &str,
    sequence: u64,
) -> Vec<u8> {
    let mut candidate = frame(wire::TransportChannel::Control, encoded(body));
    let header = candidate.header.as_mut().expect("test header");
    header.message_id = message_id.into();
    header.stream_seq = sequence;
    candidate.encode_to_vec()
}

pub(super) fn prepared_payload() -> wire::FramePayload {
    wire::FramePayload {
        body: Some(wire::frame_payload::Body::AttemptPrepared(
            wire::AttemptPrepared {
                identity: Some(wire_identity()),
                ..wire::AttemptPrepared::default()
            },
        )),
    }
}

pub(super) fn seed(direction: FrameDirection, maximum: usize) -> NegotiatedReceiverSeed {
    seed_for_channel(direction, maximum, wire::TransportChannel::Control)
}

pub(super) fn seed_for_channel(
    direction: FrameDirection,
    maximum: usize,
    channel: wire::TransportChannel,
) -> NegotiatedReceiverSeed {
    NegotiatedReceiverSeed {
        protocol: ProtocolVersion::new(1, 1),
        connection: connection(),
        identity: identity_from_wire(&wire_identity()).expect("identity"),
        channel,
        direction,
        maximum_frame_bytes: maximum,
        stream_watermark: 1,
        bootstrap_message_id: "bootstrap".into(),
        bootstrap_channel_id: u64::MAX,
    }
}

fn make_receiver(
    direction: FrameDirection,
    replay_capacity: usize,
    total_capacity: usize,
) -> AttemptFrameReceiver {
    make_receiver_with_budget(
        direction,
        replay_capacity,
        total_capacity,
        TEST_REPLAY_BYTES,
    )
}

fn make_receiver_with_budget(
    direction: FrameDirection,
    replay_capacity: usize,
    total_capacity: usize,
    max_replay_bytes: usize,
) -> AttemptFrameReceiver {
    AttemptFrameReceiver::from_seed(
        seed(direction, CONTROL_FRAME_MAX_BYTES),
        replay_capacity,
        total_capacity,
        max_replay_bytes,
    )
    .expect("valid receiver")
}

fn pending(outcome: FrameReceiveOutcome) -> Box<PendingInbound> {
    let FrameReceiveOutcome::Pending(pending) = outcome else {
        panic!("new frame must be pending");
    };
    pending
}

#[test]
fn pending_debug_redacts_attempt_payload_bytes() {
    const SECRET_MARKER: &str = "raw-secret-marker";
    let mut receiver = make_receiver(FrameDirection::HostToRunner, 2, 4);
    let bytes = bytes_with(
        wire::frame_payload::Body::PrepareAttempt(wire::PrepareAttempt {
            identity: Some(wire_identity()),
            encoded_spec: SECRET_MARKER.as_bytes().to_vec(),
            ..wire::PrepareAttempt::default()
        }),
        "prepare-debug",
        2,
    );

    let pending = pending(receiver.begin_receive(&bytes, || 2).expect("pending"));
    let debug = format!("{pending:?}");

    assert!(debug.contains("[REDACTED]"));
    assert!(!debug.contains(SECRET_MARKER));
}

fn commit_frame(receiver: &mut AttemptFrameReceiver, bytes: &[u8]) {
    let pending = pending(receiver.begin_receive(bytes, || 2).expect("pending"));
    receiver
        .commit(*pending, BoundedReplayOutcome::accepted())
        .expect("commit");
}

fn host_hello_bytes(
    protocol: (u32, u32),
    connection: &str,
    identity: wire::AttemptIdentity,
) -> Vec<u8> {
    host_hello_bytes_with_token(protocol, connection, identity, Vec::new())
}

fn host_hello_bytes_with_token(
    protocol: (u32, u32),
    connection: &str,
    identity: wire::AttemptIdentity,
    connection_session_token: Vec<u8>,
) -> Vec<u8> {
    let body = encoded(wire::frame_payload::Body::HostHello(wire::HostHello {
        selected_protocol: Some(wire::ProtocolVersion {
            major: protocol.0,
            minor: protocol.1,
        }),
        connection_id: connection.into(),
        frame_limits: Some(wire::FrameLimits {
            max_frame_bytes: CONTROL_FRAME_MAX_BYTES as u64,
            ..wire::FrameLimits::default()
        }),
        connection_session_token,
        ..wire::HostHello::default()
    }));
    let mut candidate = frame(wire::TransportChannel::Control, body);
    let header = candidate.header.as_mut().expect("header");
    header.message_id = "bootstrap".into();
    header.session_id = identity.session_id;
    header.command_id = identity.command_id;
    header.agent_run_id = identity.agent_run_id;
    header.attempt_id = identity.attempt_id;
    header.executor_owner_id = identity.executor_owner_id;
    header.fencing_epoch = identity.fencing_epoch;
    header.correlation_id = identity.correlation_id;
    header.root_agent_run_id = identity.root_agent_run_id;
    header.owner_agent_run_id = identity.owner_agent_run_id;
    header.parent_agent_run_id = identity.parent_agent_run_id;
    candidate.encode_to_vec()
}

fn delimited(bytes: &[u8], maximum: u32) -> Cursor<Vec<u8>> {
    let codec = DelimitedFrameCodec::new(maximum).expect("codec");
    let mut encoded = Vec::new();
    codec.write_raw(&mut encoded, bytes).expect("delimit");
    Cursor::new(encoded)
}

fn delimited_many(frames: &[&[u8]], maximum: u32) -> Cursor<Vec<u8>> {
    let codec = DelimitedFrameCodec::new(maximum).expect("codec");
    let mut encoded = Vec::new();
    for frame in frames {
        codec.write_raw(&mut encoded, frame).expect("delimit");
    }
    Cursor::new(encoded)
}

fn with_deadline(bytes: &[u8], deadline_at_unix_ms: i64) -> Vec<u8> {
    let mut candidate = wire::Frame::decode(bytes).expect("frame");
    candidate
        .header
        .as_mut()
        .expect("header")
        .deadline_at_unix_ms = Some(deadline_at_unix_ms);
    candidate.encode_to_vec()
}

#[derive(Debug)]
struct ClockAdvancingReader {
    inner: Cursor<Vec<u8>>,
    clock: Rc<Cell<i64>>,
}

#[derive(Debug, Clone, Default)]
struct SharedWriter {
    bytes: Rc<RefCell<Vec<u8>>>,
}

impl Write for SharedWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.bytes.borrow_mut().extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Read for ClockAdvancingReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buffer)?;
        if self.inner.position() == self.inner.get_ref().len() as u64 {
            self.clock.set(10);
        }
        Ok(read)
    }
}

fn host_selection() -> wire::HostHello {
    wire::HostHello {
        selected_protocol: Some(wire::ProtocolVersion { major: 1, minor: 1 }),
        connection_id: "connection".into(),
        frame_limits: Some(wire::FrameLimits {
            max_frame_bytes: CONTROL_FRAME_MAX_BYTES as u64,
            ..wire::FrameLimits::default()
        }),
        ..wire::HostHello::default()
    }
}

fn outbound_agent_hello() -> wire::AgentHello {
    wire::AgentHello {
        supported_protocols: Some(wire::ProtocolVersionRange {
            minimum: Some(wire::ProtocolVersion { major: 1, minor: 1 }),
            maximum: Some(wire::ProtocolVersion { major: 1, minor: 1 }),
        }),
        ..wire::AgentHello::default()
    }
}

#[test]
fn default_header_and_invalid_scalar_authority_fail_closed() {
    let payload = ack_payload();
    let candidate = wire::Frame {
        header: Some(wire::FrameHeader {
            payload_sha256: frame_payload_sha256(&payload).to_vec(),
            ..wire::FrameHeader::default()
        }),
        channel: wire::TransportChannel::Control as i32,
        encoded_payload: payload,
    };
    assert!(matches!(
        validate(candidate, wire::TransportChannel::Control),
        Err(FrameValidationError::InvalidHeader(
            FrameHeaderError::InvalidProtocolVersion(0)
        ))
    ));

    let mut zero_fence = frame(wire::TransportChannel::Control, ack_payload());
    zero_fence.header.as_mut().expect("header").fencing_epoch = 0;
    assert!(matches!(
        validate(zero_fence, wire::TransportChannel::Control),
        Err(FrameValidationError::InvalidHeader(
            FrameHeaderError::ZeroFencingEpoch
        ))
    ));
}

#[test]
fn identifier_timestamp_and_payload_identity_boundaries_are_enforced() {
    let mut maximum = frame(wire::TransportChannel::Control, ack_payload());
    maximum.header.as_mut().expect("header").connection_id = "x".repeat(MAX_WIRE_IDENTIFIER_BYTES);
    validate(maximum, wire::TransportChannel::Control).expect("boundary");

    let mut oversized = frame(wire::TransportChannel::Control, ack_payload());
    oversized.header.as_mut().expect("header").connection_id =
        "x".repeat(MAX_WIRE_IDENTIFIER_BYTES + 1);
    assert!(matches!(
        validate(oversized, wire::TransportChannel::Control),
        Err(FrameValidationError::InvalidHeader(
            FrameHeaderError::InvalidIdentifier(_)
        ))
    ));

    let mut stale = wire_identity();
    stale.root_agent_run_id = "88888888-8888-4888-8888-888888888888".into();
    let payload = encoded(wire::frame_payload::Body::PrepareAttempt(
        wire::PrepareAttempt {
            identity: Some(stale),
            ..wire::PrepareAttempt::default()
        },
    ));
    assert!(matches!(
        validate(
            frame(wire::TransportChannel::Control, payload),
            wire::TransportChannel::Control
        ),
        Err(FrameValidationError::PayloadIdentity(
            PayloadIdentityError::HeaderMismatch("PrepareAttempt")
        ))
    ));
}

#[test]
fn bootstrap_is_one_shot_directional_and_yields_a_negotiated_seed() {
    let identity = identity_from_wire(&wire_identity()).expect("identity");
    let bytes = host_hello_bytes((1, 1), "connection", wire_identity());
    let mut receiver = BootstrapReceiver::new(
        identity,
        connection(),
        FrameDirection::HostToRunner,
        CONTROL_FRAME_MAX_BYTES,
    )
    .expect("bootstrap");
    let BootstrapReceiveOutcome::HostHello(hello) =
        receiver.receive(&bytes, || 2).expect("HostHello")
    else {
        panic!("HostHello outcome");
    };
    let seed = hello.into_seed();
    assert_eq!(seed.protocol(), ProtocolVersion::new(1, 1));
    assert_eq!(seed.connection_id(), "connection");
    assert_eq!(seed.stream_watermark(), 1);
    assert_eq!(seed.maximum_frame_bytes(), CONTROL_FRAME_MAX_BYTES);
    assert!(matches!(
        receiver.receive(&bytes, || 2),
        Err(BootstrapError::Consumed)
    ));
}

#[test]
fn bootstrap_host_hello_debug_is_redacted_and_into_seed_scrubs_token() {
    let identity = identity_from_wire(&wire_identity()).expect("identity");
    let bytes = host_hello_bytes_with_token((1, 1), "connection", wire_identity(), vec![123; 16]);
    let mut receiver = BootstrapReceiver::new(
        identity,
        connection(),
        FrameDirection::HostToRunner,
        CONTROL_FRAME_MAX_BYTES,
    )
    .expect("bootstrap");

    let ((debug, seed), audit) = capture_scrub_audit(|| {
        let BootstrapReceiveOutcome::HostHello(hello) =
            receiver.receive(&bytes, || 2).expect("HostHello")
        else {
            panic!("HostHello outcome");
        };
        let debug = format!("{hello:?}");
        let seed = hello.into_seed();
        (debug, seed)
    });

    assert!(debug.contains("[TOKEN REDACTED]"));
    assert!(!debug.contains("123, 123, 123"));
    assert_eq!(seed.connection_id(), "connection");
    assert!(audit.iter().any(|entry| {
        entry.field == SecretField::HostHelloToken && entry.length == 16 && entry.all_zero
    }));
}

#[test]
fn bootstrap_rejects_stale_authority_and_host_header_disagreement() {
    let expected = identity_from_wire(&wire_identity()).expect("identity");
    let mut stale = wire_identity();
    stale.fencing_epoch += 1;
    let stale_bytes = host_hello_bytes((1, 1), "connection", stale);
    let mut authority = BootstrapReceiver::new(
        expected.clone(),
        connection(),
        FrameDirection::HostToRunner,
        CONTROL_FRAME_MAX_BYTES,
    )
    .expect("bootstrap");
    assert!(matches!(
        authority.receive(&stale_bytes, || 2),
        Err(BootstrapError::AuthorityMismatch)
    ));

    let mismatch = host_hello_bytes((1, 2), "connection", wire_identity());
    let mut protocol = BootstrapReceiver::new(
        expected,
        connection(),
        FrameDirection::HostToRunner,
        CONTROL_FRAME_MAX_BYTES,
    )
    .expect("bootstrap");
    assert!(matches!(
        protocol.receive(&mismatch, || 2),
        Err(BootstrapError::ProtocolMismatch)
    ));

    let foreign_connection = host_hello_bytes((1, 1), "connection-other", wire_identity());
    let mut connection_bound = BootstrapReceiver::new(
        identity_from_wire(&wire_identity()).expect("identity"),
        connection(),
        FrameDirection::HostToRunner,
        CONTROL_FRAME_MAX_BYTES,
    )
    .expect("bootstrap");
    assert!(matches!(
        connection_bound.receive(&foreign_connection, || 2),
        Err(BootstrapError::ConnectionMismatch)
    ));
}

#[test]
fn pending_is_single_use_and_state_advances_only_at_commit() {
    let bytes = bytes_with(
        wire::frame_payload::Body::Ack(wire::Ack::default()),
        "message-2",
        2,
    );
    let mut receiver = make_receiver(FrameDirection::HostToRunner, 2, 8);
    let mut pending = pending(receiver.begin_receive(&bytes, || 2).expect("pending"));
    assert_eq!(receiver.stream_watermark(), 1);
    assert!(receiver.has_pending());
    let (body, digest) = pending.take_body_and_digest().expect("single take");
    assert!(matches!(body, wire::frame_payload::Body::Ack(_)));
    assert_eq!(digest.len(), 32);
    assert!(matches!(
        pending.take_body_and_digest(),
        Err(InboundFrameError::PendingPayloadConsumed)
    ));
    assert!(matches!(
        receiver.begin_receive(&bytes, || 2),
        Err(InboundFrameError::PendingInboundActive)
    ));
    assert!(!receiver.is_poisoned());
    receiver
        .commit(*pending, BoundedReplayOutcome::accepted())
        .expect("commit");
    assert_eq!(receiver.stream_watermark(), 2);
}

#[test]
fn committed_receipt_matches_only_its_pre_take_binding() {
    let bytes = bytes_with(
        wire::frame_payload::Body::Ack(wire::Ack::default()),
        "message-2",
        2,
    );
    let mut first = make_receiver(FrameDirection::HostToRunner, 2, 8);
    let first_pending = pending(first.begin_receive(&bytes, || 2).expect("pending"));
    let binding = first_pending.binding();
    let receipt = first
        .commit(*first_pending, BoundedReplayOutcome::accepted())
        .expect("receipt");
    assert!(receipt.matches(&binding));

    let mut other = make_receiver(FrameDirection::HostToRunner, 2, 8);
    let other_pending = pending(other.begin_receive(&bytes, || 2).expect("pending"));
    assert!(!binding.matches(&other_pending.binding()));
    assert!(binding.matches(&binding.clone()));
    assert!(!receipt.matches(&other_pending.binding()));
}

#[test]
fn a_foreign_pending_token_cannot_produce_a_commit_receipt() {
    let bytes = bytes_with(
        wire::frame_payload::Body::Ack(wire::Ack::default()),
        "message-2",
        2,
    );
    let mut target = make_receiver(FrameDirection::HostToRunner, 2, 8);
    let _target_pending = pending(target.begin_receive(&bytes, || 2).expect("target"));
    let mut foreign = make_receiver(FrameDirection::HostToRunner, 2, 8);
    let foreign_pending = pending(foreign.begin_receive(&bytes, || 2).expect("foreign"));
    let result = target.commit(*foreign_pending, BoundedReplayOutcome::accepted());
    assert!(matches!(result, Err(InboundFrameError::InvalidPending)));
    assert!(target.is_poisoned());
}

#[test]
fn committed_replay_preserves_exact_digest_and_bounded_outcome() {
    let bytes = with_deadline(
        &bytes_with(
            wire::frame_payload::Body::Ack(wire::Ack::default()),
            "message-2",
            2,
        ),
        3,
    );
    let mut receiver = make_receiver(FrameDirection::HostToRunner, 2, 8);
    let pending = pending(receiver.begin_receive(&bytes, || 2).expect("pending"));
    let response = receiver.bounded_response(vec![7, 8, 9]).expect("bounded");
    let response_allocation = response.response_bytes().expect("response").as_ptr();
    receiver.commit(*pending, response).expect("commit");

    let FrameReceiveOutcome::Replay(replay) = receiver
        .begin_receive(&bytes, || 3)
        .expect("expired exact replay")
    else {
        panic!("replay");
    };
    assert_eq!(replay.envelope_digest(), &frame_envelope_sha256(&bytes));
    let replay_response = receiver
        .take_replay_response(&replay)
        .expect("matching replay reservation")
        .expect("response");
    assert_eq!(replay_response.as_ref(), [7, 8, 9].as_slice());
    assert!(std::ptr::eq(response_allocation, replay_response.as_ptr()));
}

#[test]
fn fresh_expired_frame_still_fails_closed() {
    let bytes = with_deadline(
        &bytes_with(
            wire::frame_payload::Body::Ack(wire::Ack::default()),
            "message-2",
            2,
        ),
        3,
    );
    let mut receiver = make_receiver(FrameDirection::HostToRunner, 2, 8);

    assert!(matches!(
        receiver.begin_receive(&bytes, || 3),
        Err(InboundFrameError::DeadlineExpired {
            deadline_at: 3,
            observed_at: 3
        })
    ));
    assert!(receiver.is_poisoned());
}

#[test]
fn replay_budget_counts_unique_buffers_and_releases_evicted_allocations() {
    let second = bytes_with(
        wire::frame_payload::Body::Ack(wire::Ack::default()),
        "message-2",
        2,
    );
    let third = bytes_with(
        wire::frame_payload::Body::Ack(wire::Ack::default()),
        "message-3",
        3,
    );
    let mut shared = make_receiver_with_budget(FrameDirection::HostToRunner, 2, 8, 3);
    let response = shared.bounded_response(vec![1, 2, 3]).expect("bounded");
    let second_pending = pending(shared.begin_receive(&second, || 2).expect("second"));
    shared
        .commit(*second_pending, response.clone())
        .expect("second commit");
    let third_pending = pending(shared.begin_receive(&third, || 2).expect("third"));
    shared
        .commit(*third_pending, response)
        .expect("shared allocation");
    assert_eq!(shared.replay_bytes(), 3);

    let mut evicting = make_receiver_with_budget(FrameDirection::HostToRunner, 1, 4, 3);
    let second_pending = pending(evicting.begin_receive(&second, || 2).expect("second"));
    let response = evicting.bounded_response(vec![1, 2, 3]).expect("first");
    evicting
        .commit(*second_pending, response)
        .expect("second commit");
    let third_pending = pending(evicting.begin_receive(&third, || 2).expect("third"));
    let response = evicting.bounded_response(vec![4, 5, 6]).expect("second");
    evicting
        .commit(*third_pending, response)
        .expect("eviction frees bytes");
    assert_eq!(evicting.replay_bytes(), 3);
    assert_eq!(evicting.tombstone_count(), 2);
    assert!(matches!(
        evicting.begin_receive(&second, || 2),
        Err(InboundFrameError::MessageIdRetired)
    ));
}

#[test]
fn reject_keeps_watermark_uncommitted_and_poisons_receiver() {
    let bytes = bytes_with(
        wire::frame_payload::Body::Ack(wire::Ack::default()),
        "message-2",
        2,
    );
    let mut receiver = make_receiver(FrameDirection::HostToRunner, 2, 8);
    let pending = pending(receiver.begin_receive(&bytes, || 2).expect("pending"));
    receiver.reject(*pending).expect("reject exact token");
    assert_eq!(receiver.stream_watermark(), 1);
    assert!(receiver.is_poisoned());
}

#[test]
fn poison_releases_retained_replay_history() {
    let bytes = bytes_with(
        wire::frame_payload::Body::Ack(wire::Ack::default()),
        "message-2",
        2,
    );
    let mut receiver = make_receiver_with_budget(FrameDirection::HostToRunner, 2, 8, 3);
    let pending = pending(receiver.begin_receive(&bytes, || 2).expect("pending"));
    let response = receiver.bounded_response(vec![1, 2, 3]).expect("bounded");
    receiver.commit(*pending, response).expect("commit");
    assert_eq!(receiver.replay_entry_count(), 1);
    assert_eq!(receiver.replay_bytes(), 3);

    let conflict = bytes_with(
        wire::frame_payload::Body::Ack(wire::Ack::default()),
        "message-2",
        3,
    );
    assert!(matches!(
        receiver.begin_receive(&conflict, || 2),
        Err(InboundFrameError::MessageIdConflict)
    ));
    assert!(receiver.is_poisoned());
    assert_eq!(receiver.replay_entry_count(), 0);
    assert_eq!(receiver.tombstone_count(), 0);
    assert_eq!(receiver.replay_bytes(), 0);
}

#[test]
fn evicted_ids_become_tombstones_and_total_capacity_fails_closed() {
    let second = bytes_with(
        wire::frame_payload::Body::Ack(wire::Ack::default()),
        "message-2",
        2,
    );
    let third = bytes_with(
        wire::frame_payload::Body::Ack(wire::Ack::default()),
        "message-3",
        3,
    );
    let mut tombstones = make_receiver(FrameDirection::HostToRunner, 1, 3);
    commit_frame(&mut tombstones, &second);
    commit_frame(&mut tombstones, &third);
    assert_eq!(tombstones.tombstone_count(), 2);
    assert!(matches!(
        tombstones.begin_receive(&second, || 2),
        Err(InboundFrameError::MessageIdRetired)
    ));

    let mut full = make_receiver(FrameDirection::HostToRunner, 2, 2);
    commit_frame(&mut full, &second);
    assert!(matches!(
        full.begin_receive(&third, || 2),
        Err(InboundFrameError::IdentityCapacityExhausted)
    ));
}

#[test]
fn safe_channel_owners_require_exact_caps_and_couple_poison() {
    let control_maximum = u32::try_from(CONTROL_FRAME_MAX_BYTES).expect("u32 cap");
    let larger = DelimitedFrameChannel::new(
        DelimitedFrameCodec::new(2_048).expect("codec"),
        Cursor::new(Vec::<u8>::new()),
        Vec::<u8>::new(),
    );
    assert!(matches!(
        EstablishedAttemptChannel::new(
            larger,
            AttemptFrameReceiver::from_seed(
                seed(FrameDirection::HostToRunner, 1_024),
                2,
                8,
                TEST_REPLAY_BYTES
            )
            .expect("receiver")
        ),
        Err(EstablishedChannelError::PhysicalCapMismatch { .. })
    ));

    let smaller = DelimitedFrameChannel::new(
        DelimitedFrameCodec::new(512).expect("codec"),
        Cursor::new(Vec::<u8>::new()),
        Vec::<u8>::new(),
    );
    assert!(matches!(
        EstablishedAttemptChannel::new(
            smaller,
            AttemptFrameReceiver::from_seed(
                seed(FrameDirection::HostToRunner, 1_024),
                2,
                8,
                TEST_REPLAY_BYTES
            )
            .expect("receiver")
        ),
        Err(EstablishedChannelError::PhysicalCapMismatch { .. })
    ));

    let invalid = bytes_with(
        wire::frame_payload::Body::AgentHello(wire::AgentHello::default()),
        "message-2",
        2,
    );
    let transport = DelimitedFrameChannel::new(
        DelimitedFrameCodec::new(control_maximum).expect("codec"),
        delimited(&invalid, control_maximum),
        Vec::<u8>::new(),
    );
    let receiver = make_receiver(FrameDirection::HostToRunner, 2, 8);
    let mut established = EstablishedAttemptChannel::new(transport, receiver).expect("channel");
    assert!(matches!(
        established.begin_receive(|| 2),
        Err(EstablishedChannelError::Inbound(
            InboundFrameError::Direction(_)
        ))
    ));
    assert!(established.is_poisoned());
}

#[test]
fn safe_channel_owners_sample_the_clock_only_after_the_frame_arrives() {
    let maximum = u32::try_from(CONTROL_FRAME_MAX_BYTES).expect("u32 cap");
    let bootstrap_clock = Rc::new(Cell::new(1));
    let hello = with_deadline(&host_hello_bytes((1, 1), "connection", wire_identity()), 10);
    let transport = DelimitedFrameChannel::new(
        DelimitedFrameCodec::new(maximum).expect("codec"),
        ClockAdvancingReader {
            inner: delimited(&hello, maximum),
            clock: Rc::clone(&bootstrap_clock),
        },
        Vec::<u8>::new(),
    );
    let mut bootstrap = BootstrapAttemptChannel::new(
        transport,
        identity_from_wire(&wire_identity()).expect("identity"),
        connection(),
        FrameDirection::HostToRunner,
        CONTROL_FRAME_MAX_BYTES,
    )
    .expect("bootstrap");
    bootstrap
        .send_agent_hello(&outbound_agent_hello(), || bootstrap_clock.get())
        .expect("send AgentHello");
    assert!(matches!(
        bootstrap.receive(|| bootstrap_clock.get()),
        Err(BootstrapChannelError::Bootstrap(
            BootstrapError::DeadlineExpired {
                observed_at: 10,
                ..
            }
        ))
    ));

    let established_clock = Rc::new(Cell::new(1));
    let frame = with_deadline(
        &bytes_with(
            wire::frame_payload::Body::Ack(wire::Ack::default()),
            "message-2",
            2,
        ),
        10,
    );
    let transport = DelimitedFrameChannel::new(
        DelimitedFrameCodec::new(maximum).expect("codec"),
        ClockAdvancingReader {
            inner: delimited(&frame, maximum),
            clock: Rc::clone(&established_clock),
        },
        Vec::<u8>::new(),
    );
    let receiver = make_receiver(FrameDirection::HostToRunner, 2, 8);
    let mut established = EstablishedAttemptChannel::new(transport, receiver).expect("channel");
    assert!(matches!(
        established.begin_receive(|| established_clock.get()),
        Err(EstablishedChannelError::Inbound(
            InboundFrameError::DeadlineExpired {
                observed_at: 10,
                ..
            }
        ))
    ));
}

#[test]
fn bootstrap_owner_rejects_larger_physical_cap_before_reading() {
    let control_maximum = u32::try_from(CONTROL_FRAME_MAX_BYTES).expect("u32 cap");
    let transport = DelimitedFrameChannel::new(
        DelimitedFrameCodec::new(control_maximum + 1).expect("codec"),
        Cursor::new(Vec::<u8>::new()),
        Vec::<u8>::new(),
    );
    assert!(matches!(
        BootstrapAttemptChannel::new(
            transport,
            identity_from_wire(&wire_identity()).expect("identity"),
            connection(),
            FrameDirection::HostToRunner,
            CONTROL_FRAME_MAX_BYTES,
        ),
        Err(BootstrapChannelError::PhysicalCapMismatch { .. })
    ));
}

#[test]
fn bootstrap_rejects_invalid_send_and_host_hello_before_agent_hello() {
    let maximum = u32::try_from(CONTROL_FRAME_MAX_BYTES).expect("u32 cap");
    let transport = DelimitedFrameChannel::new(
        DelimitedFrameCodec::new(maximum).expect("codec"),
        Cursor::new(Vec::<u8>::new()),
        Vec::<u8>::new(),
    );
    let mut invalid = BootstrapAttemptChannel::new(
        transport,
        identity_from_wire(&wire_identity()).expect("identity"),
        connection(),
        FrameDirection::HostToRunner,
        CONTROL_FRAME_MAX_BYTES,
    )
    .expect("bootstrap");
    assert!(matches!(
        invalid.send_agent_hello(&wire::AgentHello::default(), || 1),
        Err(BootstrapChannelError::Bootstrap(
            BootstrapError::InvalidSelectedProtocol
        ))
    ));
    assert!(invalid.is_poisoned());
    assert!(
        invalid
            .send_agent_hello(&outbound_agent_hello(), || 1)
            .is_err()
    );

    let hello = host_hello_bytes((1, 1), "connection", wire_identity());
    let transport = DelimitedFrameChannel::new(
        DelimitedFrameCodec::new(maximum).expect("codec"),
        delimited(&hello, maximum),
        Vec::<u8>::new(),
    );
    let mut wrong_order = BootstrapAttemptChannel::new(
        transport,
        identity_from_wire(&wire_identity()).expect("identity"),
        connection(),
        FrameDirection::HostToRunner,
        CONTROL_FRAME_MAX_BYTES,
    )
    .expect("bootstrap");
    assert!(matches!(
        wrong_order.receive(|| 2),
        Err(BootstrapChannelError::MissingOutboundHello)
    ));
    assert!(wrong_order.is_poisoned());
}

#[test]
fn host_hello_handoff_preserves_the_same_stream_and_queued_frame() {
    let maximum = u32::try_from(CONTROL_FRAME_MAX_BYTES).expect("u32 cap");
    let hello = host_hello_bytes((1, 1), "connection", wire_identity());
    let next = bytes_with(
        wire::frame_payload::Body::Ack(wire::Ack::default()),
        "message-2",
        2,
    );
    let transport = DelimitedFrameChannel::new(
        DelimitedFrameCodec::new(maximum).expect("codec"),
        delimited_many(&[&hello, &next], maximum),
        Vec::<u8>::new(),
    );
    let mut bootstrap = BootstrapAttemptChannel::new(
        transport,
        identity_from_wire(&wire_identity()).expect("identity"),
        connection(),
        FrameDirection::HostToRunner,
        CONTROL_FRAME_MAX_BYTES,
    )
    .expect("bootstrap owner");
    bootstrap
        .send_agent_hello(&outbound_agent_hello(), || 1)
        .expect("send AgentHello");
    let BootstrapReceiveOutcome::HostHello(hello) = bootstrap.receive(|| 2).expect("HostHello")
    else {
        panic!("HostHello");
    };
    let seed = hello.into_seed();
    let mut established = bootstrap
        .into_established(seed, 2, 8, TEST_REPLAY_BYTES)
        .expect("handoff");
    assert!(matches!(
        established.begin_receive(|| 2).expect("queued frame"),
        FrameReceiveOutcome::Pending(_)
    ));
}

#[test]
fn agent_hello_negotiation_produces_a_same_channel_reverse_seed() {
    let maximum = u32::try_from(CONTROL_FRAME_MAX_BYTES).expect("u32 cap");
    let hello = bytes_with(
        wire::frame_payload::Body::AgentHello(wire::AgentHello::default()),
        "bootstrap-agent",
        1,
    );
    let next = bytes_with(
        wire::frame_payload::Body::Ack(wire::Ack::default()),
        "message-2",
        2,
    );
    let transport = DelimitedFrameChannel::new(
        DelimitedFrameCodec::new(maximum).expect("codec"),
        delimited_many(&[&hello, &next], maximum),
        Vec::<u8>::new(),
    );
    let mut bootstrap = BootstrapAttemptChannel::new(
        transport,
        identity_from_wire(&wire_identity()).expect("identity"),
        connection(),
        FrameDirection::RunnerToHost,
        CONTROL_FRAME_MAX_BYTES,
    )
    .expect("bootstrap owner");
    let BootstrapReceiveOutcome::AgentHello(hello) = bootstrap.receive(|| 2).expect("AgentHello")
    else {
        panic!("AgentHello");
    };
    assert_eq!(hello.hello(), &wire::AgentHello::default());
    let selection = host_selection();
    let seed = hello.negotiate(&selection).expect("host selection");
    bootstrap
        .send_host_hello(&selection, || 1)
        .expect("send HostHello");
    let mut established = bootstrap
        .into_established(seed, 2, 8, TEST_REPLAY_BYTES)
        .expect("handoff");
    assert!(matches!(
        established.begin_receive(|| 2).expect("queued frame"),
        FrameReceiveOutcome::Pending(_)
    ));
}

#[test]
fn bootstrap_handoff_rejects_a_seed_from_another_channel() {
    let maximum = u32::try_from(CONTROL_FRAME_MAX_BYTES).expect("u32 cap");
    let hello = host_hello_bytes((1, 1), "connection", wire_identity());
    let transport = DelimitedFrameChannel::new(
        DelimitedFrameCodec::new(maximum).expect("codec"),
        delimited(&hello, maximum),
        Vec::<u8>::new(),
    );
    let mut bootstrap = BootstrapAttemptChannel::new(
        transport,
        identity_from_wire(&wire_identity()).expect("identity"),
        connection(),
        FrameDirection::HostToRunner,
        CONTROL_FRAME_MAX_BYTES,
    )
    .expect("bootstrap owner");
    bootstrap
        .send_agent_hello(&outbound_agent_hello(), || 1)
        .expect("send AgentHello");
    bootstrap.receive(|| 2).expect("consume valid Hello");
    assert!(matches!(
        bootstrap.into_established(
            seed(FrameDirection::HostToRunner, CONTROL_FRAME_MAX_BYTES),
            2,
            8,
            TEST_REPLAY_BYTES
        ),
        Err(BootstrapChannelError::SeedChannelMismatch)
    ));
}

#[derive(Debug)]
struct FailingWriter;

impl Write for FailingWriter {
    fn write(&mut self, _buffer: &[u8]) -> io::Result<usize> {
        Err(io::Error::other("forced write failure"))
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn response_write_failure_drops_receipt_and_poisons_established_channel() {
    let maximum = u32::try_from(CONTROL_FRAME_MAX_BYTES).expect("u32 cap");
    let bytes = bytes_with(
        wire::frame_payload::Body::Ack(wire::Ack::default()),
        "message-2",
        2,
    );
    let transport = DelimitedFrameChannel::new(
        DelimitedFrameCodec::new(maximum).expect("codec"),
        delimited(&bytes, maximum),
        FailingWriter,
    );
    let receiver = make_receiver(FrameDirection::HostToRunner, 2, 8);
    let mut established = EstablishedAttemptChannel::new(transport, receiver).expect("channel");
    let FrameReceiveOutcome::Pending(pending) = established.begin_receive(|| 2).expect("pending")
    else {
        panic!("pending");
    };
    let result = established.commit_response(*pending, &prepared_payload(), 10, || 2);
    assert!(matches!(result, Err(EstablishedChannelError::Framing(_))));
    assert!(established.is_poisoned());
}

#[test]
fn established_eof_is_an_explicit_poisoning_failure() {
    let maximum = u32::try_from(CONTROL_FRAME_MAX_BYTES).expect("u32 cap");
    let transport = DelimitedFrameChannel::new(
        DelimitedFrameCodec::new(maximum).expect("codec"),
        Cursor::new(Vec::<u8>::new()),
        Vec::<u8>::new(),
    );
    let receiver = make_receiver(FrameDirection::HostToRunner, 2, 8);
    let mut established = EstablishedAttemptChannel::new(transport, receiver).expect("channel");

    assert!(matches!(
        established.begin_receive(|| 2),
        Err(EstablishedChannelError::UnexpectedEof)
    ));
    assert!(established.is_poisoned());
}

#[test]
fn response_at_its_deadline_is_rejected_before_any_write() {
    let maximum = u32::try_from(CONTROL_FRAME_MAX_BYTES).expect("u32 cap");
    let bytes = bytes_with(
        wire::frame_payload::Body::Ack(wire::Ack::default()),
        "message-2",
        2,
    );
    let writer = SharedWriter::default();
    let transport = DelimitedFrameChannel::new(
        DelimitedFrameCodec::new(maximum).expect("codec"),
        delimited(&bytes, maximum),
        writer.clone(),
    );
    let receiver = make_receiver(FrameDirection::HostToRunner, 2, 8);
    let mut established = EstablishedAttemptChannel::new(transport, receiver).expect("channel");
    let FrameReceiveOutcome::Pending(pending) = established.begin_receive(|| 2).expect("pending")
    else {
        panic!("pending");
    };

    let result = established.commit_response(*pending, &prepared_payload(), 2, || 2);

    assert!(matches!(
        result,
        Err(EstablishedChannelError::Outbound(
            OutboundFrameError::Frame(FrameValidationError::InvalidHeader(
                FrameHeaderError::InvalidDeadline {
                    sent_at: 2,
                    deadline_at: 2
                }
            ))
        ))
    ));
    assert!(writer.bytes.borrow().is_empty());
    assert!(established.is_poisoned());
}

#[test]
fn established_sender_owns_sequence_reply_binding_and_exact_replay_bytes() {
    let maximum = u32::try_from(CONTROL_FRAME_MAX_BYTES).expect("u32 cap");
    let second = bytes_with(
        wire::frame_payload::Body::Ack(wire::Ack::default()),
        "message-2",
        2,
    );
    let third = bytes_with(
        wire::frame_payload::Body::Ack(wire::Ack::default()),
        "message-3",
        3,
    );
    let writer = SharedWriter::default();
    let transport = DelimitedFrameChannel::new(
        DelimitedFrameCodec::new(maximum).expect("codec"),
        delimited_many(&[&second, &second, &third], maximum),
        writer.clone(),
    );
    let receiver = make_receiver(FrameDirection::HostToRunner, 3, 8);
    let mut established = EstablishedAttemptChannel::new(transport, receiver).expect("channel");

    let FrameReceiveOutcome::Pending(pending) = established.begin_receive(|| 2).expect("second")
    else {
        panic!("pending");
    };
    let binding = pending.binding();
    let committed = established
        .commit_response(*pending, &prepared_payload(), 10, || 2)
        .expect("response");
    let receipt = committed.into_receipt();
    assert!(receipt.matches(&binding));
    let first_response = writer.bytes.borrow().clone();
    let mut first_written = Cursor::new(first_response);
    let codec = DelimitedFrameCodec::new(maximum).expect("codec");
    let first_bytes = codec
        .read_raw(&mut first_written)
        .expect("first")
        .expect("frame");
    let first = wire::Frame::decode(first_bytes.as_slice()).expect("outbound frame");
    let header = first.header.expect("header");
    assert_eq!(header.stream_seq, 2);
    assert_eq!(header.reply_to_message_id.as_deref(), Some("message-2"));
    assert_eq!(header.connection_id, "connection");

    let FrameReceiveOutcome::Replay(replay) = established.begin_receive(|| 2).expect("replay")
    else {
        panic!("replay");
    };
    assert_eq!(replay.message_id(), "message-2");

    let FrameReceiveOutcome::Pending(pending) = established.begin_receive(|| 2).expect("third")
    else {
        panic!("pending");
    };
    let committed = established
        .commit_response(*pending, &prepared_payload(), 10, || 2)
        .expect("response");
    drop(committed);
    let mut written = Cursor::new(writer.bytes.borrow().clone());
    let first_write = codec.read_raw(&mut written).expect("first").expect("frame");
    let replay_write = codec
        .read_raw(&mut written)
        .expect("replay")
        .expect("frame");
    let third_response = codec.read_raw(&mut written).expect("third").expect("frame");
    let third_frame = wire::Frame::decode(third_response.as_slice()).expect("outbound frame");
    let third_header = third_frame.header.expect("header");
    assert_eq!(third_header.stream_seq, 3);
    assert_eq!(
        third_header.reply_to_message_id.as_deref(),
        Some("message-3")
    );
    assert_ne!(third_response, first_bytes);
    assert_eq!(first_write, replay_write);
}

#[test]
fn replay_response_over_budget_closes_the_established_channel() {
    let maximum = u32::try_from(CONTROL_FRAME_MAX_BYTES).expect("u32 cap");
    let second = bytes_with(
        wire::frame_payload::Body::Ack(wire::Ack::default()),
        "message-2",
        2,
    );
    let third = bytes_with(
        wire::frame_payload::Body::Ack(wire::Ack::default()),
        "message-3",
        3,
    );
    let transport = DelimitedFrameChannel::new(
        DelimitedFrameCodec::new(maximum).expect("codec"),
        delimited_many(&[&second, &third], maximum),
        Vec::<u8>::new(),
    );
    let receiver = make_receiver_with_budget(FrameDirection::HostToRunner, 2, 8, 3);
    let mut established = EstablishedAttemptChannel::new(transport, receiver).expect("channel");
    let FrameReceiveOutcome::Pending(pending) = established.begin_receive(|| 2).expect("second")
    else {
        panic!("pending");
    };
    established.commit_accepted(*pending).expect("first commit");

    let FrameReceiveOutcome::Pending(pending) = established.begin_receive(|| 2).expect("third")
    else {
        panic!("pending");
    };
    assert!(matches!(
        established.commit_response(*pending, &prepared_payload(), 10, || 2),
        Err(EstablishedChannelError::Inbound(
            InboundFrameError::ReplayByteBudgetExhausted {
                required,
                maximum: 3
            }
        )) if required > 3
    ));
    assert!(established.is_poisoned());
}
