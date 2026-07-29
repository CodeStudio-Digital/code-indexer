use std::time::{Duration, SystemTime, UNIX_EPOCH};

use prost::Message;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream, duplex};
use tokio::time::timeout;

use super::*;
use crate::generated::v1 as wire;
use crate::management_channel::sender::encode_bootstrap;
use crate::management_channel::tests::support::{
    MANAGEMENT_TOKEN, SUPERVISOR_NONCE, attempt_identity, connection, host_hello, payload,
    protocol, supervisor_hello,
};
use crate::management_channel::{ManagementDirection, ManagementPayloadKind};

mod additional;

fn now_ms() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_millis(),
    )
    .expect("timestamp fits")
}

fn hello_with_timeout(timeout_ms: u64) -> wire::HostSupervisorHello {
    let mut hello = host_hello();
    let frame = hello.frame_limits.as_mut().expect("frame limits");
    frame.read_timeout_ms = timeout_ms;
    frame.write_timeout_ms = timeout_ms;
    hello
}

async fn pair(
    hello: wire::HostSupervisorHello,
) -> (
    AsyncEstablishedManagementActor,
    AsyncEstablishedManagementActor,
) {
    let (host_stream, supervisor_stream) = duplex(256 * 1024);
    let host = AsyncBootstrapManagementActor::host(
        host_stream,
        connection(),
        SUPERVISOR_NONCE.to_vec(),
        MANAGEMENT_TOKEN.to_vec(),
    )
    .expect("host bootstrap");
    let supervisor = AsyncBootstrapManagementActor::supervisor(
        supervisor_stream,
        connection(),
        SUPERVISOR_NONCE.to_vec(),
        MANAGEMENT_TOKEN.to_vec(),
    )
    .expect("supervisor bootstrap");
    let supervisor_hello = supervisor_hello();
    let (host, supervisor) = tokio::join!(
        host.establish_host(&hello),
        supervisor.establish_supervisor(&supervisor_hello)
    );
    (
        host.expect("host established"),
        supervisor.expect("supervisor established"),
    )
}

fn query() -> wire::ManagementPayload {
    payload(wire::management_payload::Body::QuerySupervisorState(
        wire::QuerySupervisorState::default(),
    ))
}

fn cancel() -> wire::ManagementPayload {
    payload(wire::management_payload::Body::CancelAttemptProcess(
        wire::CancelAttemptProcess {
            identity: Some(attempt_identity()),
            grace_deadline_at_unix_ms: now_ms() + 5_000,
            reason_code: "test.cancel".into(),
            idempotency_key: "cancel:test".into(),
        },
    ))
}

#[tokio::test]
async fn same_stream_handshake_hands_off_sequence_two_and_ack_while_read_is_pending() {
    let (mut host, mut supervisor) = pair(hello_with_timeout(2_000)).await;
    let sent = host
        .command_port()
        .send(cancel())
        .await
        .expect("cancel physically written");
    assert_eq!(sent.stream_seq(), 2);

    let event = timeout(Duration::from_secs(1), supervisor.receive())
        .await
        .expect("supervisor event deadline")
        .expect("supervisor event")
        .expect("valid supervisor event");
    let AsyncManagementEvent::Pending(mut pending) = event else {
        panic!("cancel must be pending");
    };
    assert_eq!(pending.kind(), ManagementPayloadKind::CancelAttemptProcess);
    assert_eq!(pending.pending_mut().header().stream_seq, 2);
    let response = pending
        .acknowledge()
        .expect("queue ACK after durable commit");
    assert_eq!(
        response
            .written()
            .await
            .expect("ACK physically written")
            .stream_seq(),
        2
    );

    let event = timeout(Duration::from_secs(1), host.receive())
        .await
        .expect("host event deadline")
        .expect("host event")
        .expect("valid host event");
    let AsyncManagementEvent::Acknowledged(acknowledged) = event else {
        panic!("host must receive the committed ACK body");
    };
    assert_eq!(
        acknowledged.acknowledgement().acknowledged_message_id,
        sent.message_id()
    );
    assert_eq!(
        acknowledged.acknowledgement().acknowledged_payload_sha256,
        sent.payload_digest().as_slice()
    );
    assert_eq!(acknowledged.committed().stream_seq(), 2);
}

#[tokio::test]
async fn every_outstanding_frame_expires_even_when_window_still_has_capacity() {
    let mut hello = hello_with_timeout(60);
    hello
        .frame_limits
        .as_mut()
        .expect("frame limits")
        .max_in_flight_frames = 4;
    let (mut host, mut supervisor) = pair(hello).await;
    host.command_port()
        .send(query())
        .await
        .expect("query physically written");
    let held = supervisor
        .receive()
        .await
        .expect("query event")
        .expect("valid query");
    assert!(matches!(held, AsyncManagementEvent::Pending(_)));

    let error = timeout(Duration::from_secs(1), host.receive())
        .await
        .expect("outstanding reaper")
        .expect("terminal actor event")
        .expect_err("missing ACK must close");
    assert!(matches!(
        error,
        AsyncManagementActorError::OutstandingDeadlineElapsed
    ));
}

#[tokio::test]
async fn priority_is_assigned_before_sequence_and_matches_physical_order() {
    let hello = hello_with_timeout(2_000);
    let (mut raw, host) = host_with_raw_peer(hello, 64).await;
    let port = host.command_port();
    let first = port.enqueue(query()).expect("first query queued");
    tokio::task::yield_now().await;
    let normal = port.enqueue(query()).expect("normal queued");
    let urgent = port.enqueue(cancel()).expect("urgent queued");
    drop(port);

    let (first_header, first_payload) = read_management_frame(&mut raw).await;
    assert_eq!(first_header.stream_seq, 2);
    assert!(matches!(
        first_payload.body,
        Some(wire::management_payload::Body::QuerySupervisorState(_))
    ));
    assert_eq!(
        first.written().await.expect("first written").stream_seq(),
        2
    );

    let (urgent_header, urgent_payload) = read_management_frame(&mut raw).await;
    assert_eq!(urgent_header.stream_seq, 3);
    assert!(matches!(
        urgent_payload.body,
        Some(wire::management_payload::Body::CancelAttemptProcess(_))
    ));
    assert_eq!(
        urgent.written().await.expect("urgent written").stream_seq(),
        3
    );

    let (normal_header, normal_payload) = read_management_frame(&mut raw).await;
    assert_eq!(normal_header.stream_seq, 4);
    assert!(matches!(
        normal_payload.body,
        Some(wire::management_payload::Body::QuerySupervisorState(_))
    ));
    assert_eq!(
        normal.written().await.expect("normal written").stream_seq(),
        4
    );
}

#[tokio::test]
async fn partial_inbound_frame_times_out_and_closes_both_stream_halves() {
    let hello = hello_with_timeout(40);
    let (mut raw, mut supervisor) = supervisor_with_raw_peer(hello, 1024).await;
    raw.write_all(&[10]).await.expect("partial frame prefix");

    let error = timeout(Duration::from_secs(1), supervisor.receive())
        .await
        .expect("partial read reaper")
        .expect("terminal actor event")
        .expect_err("partial read must poison");
    assert!(matches!(
        error,
        AsyncManagementActorError::PhysicalReadDeadlineElapsed
    ));
    tokio::task::yield_now().await;
    assert!(raw.write_all(&[1, 0]).await.is_err());
}

#[tokio::test]
async fn partial_outbound_write_times_out_and_closes_reader_owner() {
    let hello = hello_with_timeout(250);
    let (mut raw, host) = host_with_raw_peer(hello, 64).await;
    let write = host
        .command_port()
        .enqueue(query())
        .expect("query accepted by bounded queue");
    let error = timeout(Duration::from_secs(1), write.written())
        .await
        .expect("partial write reaper")
        .expect_err("blocked write must poison");
    assert!(matches!(
        error,
        AsyncManagementActorError::PhysicalWriteDeadlineElapsed
    ));
    tokio::task::yield_now().await;
    assert!(raw.write_all(&[1, 0]).await.is_err());
}

async fn host_with_raw_peer(
    hello: wire::HostSupervisorHello,
    capacity: usize,
) -> (DuplexStream, AsyncEstablishedManagementActor) {
    let (host_stream, mut raw) = duplex(capacity);
    let bootstrap = AsyncBootstrapManagementActor::host(
        host_stream,
        connection(),
        SUPERVISOR_NONCE.to_vec(),
        MANAGEMENT_TOKEN.to_vec(),
    )
    .expect("host bootstrap");
    let peer = async {
        let _ = read_management_frame(&mut raw).await;
        write_bootstrap(
            &mut raw,
            wire::management_payload::Body::SupervisorHello(supervisor_hello()),
            ManagementDirection::SupervisorToHost,
        )
        .await;
        raw
    };
    let (actor, raw) = tokio::join!(bootstrap.establish_host(&hello), peer);
    (raw, actor.expect("host established"))
}

async fn supervisor_with_raw_peer(
    hello: wire::HostSupervisorHello,
    capacity: usize,
) -> (DuplexStream, AsyncEstablishedManagementActor) {
    let (mut raw, supervisor_stream) = duplex(capacity);
    let bootstrap = AsyncBootstrapManagementActor::supervisor(
        supervisor_stream,
        connection(),
        SUPERVISOR_NONCE.to_vec(),
        MANAGEMENT_TOKEN.to_vec(),
    )
    .expect("supervisor bootstrap");
    let supervisor_hello = supervisor_hello();
    let peer = async {
        write_bootstrap(
            &mut raw,
            wire::management_payload::Body::HostSupervisorHello(hello),
            ManagementDirection::HostToSupervisor,
        )
        .await;
        let _ = read_management_frame(&mut raw).await;
        raw
    };
    let (actor, raw) = tokio::join!(bootstrap.establish_supervisor(&supervisor_hello), peer);
    (raw, actor.expect("supervisor established"))
}

async fn write_bootstrap(
    stream: &mut DuplexStream,
    body: wire::management_payload::Body,
    direction: ManagementDirection,
) {
    let frame = encode_bootstrap(
        protocol(),
        &connection(),
        direction,
        900,
        &payload(body),
        now_ms(),
    )
    .expect("bootstrap frame");
    write_delimited(stream, &frame).await;
}

async fn write_delimited(stream: &mut DuplexStream, frame: &[u8]) {
    let length = u32::try_from(frame.len()).expect("test frame length");
    let (prefix, prefix_length) = crate::framing::encode_length(length);
    stream
        .write_all(&prefix[..prefix_length])
        .await
        .expect("frame prefix");
    stream.write_all(frame).await.expect("frame body");
}

async fn read_management_frame(
    stream: &mut DuplexStream,
) -> (wire::ManagementFrameHeader, wire::ManagementPayload) {
    let mut length = 0_u32;
    for index in 0..5 {
        let byte = stream.read_u8().await.expect("frame length byte");
        if let Some(value) =
            crate::framing::decode_length_byte(&mut length, index, byte).expect("canonical length")
        {
            length = value;
            break;
        }
    }
    let mut encoded = vec![0_u8; length as usize];
    stream.read_exact(&mut encoded).await.expect("frame body");
    let frame = wire::ManagementFrame::decode(encoded.as_slice()).expect("management frame");
    let payload =
        wire::ManagementPayload::decode(frame.encoded_payload.as_slice()).expect("payload");
    (frame.header.expect("frame header"), payload)
}
