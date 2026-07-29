use std::time::Duration;

use prost::Message;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::time::{sleep, timeout};

use super::*;
use crate::management_frame::encode_management_frame;

fn sample() -> wire::ManagementPayload {
    payload(wire::management_payload::Body::SupervisorResourceSample(
        wire::SupervisorResourceSample {
            sampled_at_unix_ms: safe_now_ms(),
            ..wire::SupervisorResourceSample::default()
        },
    ))
}

fn state() -> wire::ManagementPayload {
    payload(wire::management_payload::Body::SupervisorState(
        wire::SupervisorState {
            connection_id: connection().as_str().into(),
            accepting_launches: true,
            observed_at_unix_ms: safe_now_ms(),
            ..wire::SupervisorState::default()
        },
    ))
}

#[tokio::test]
async fn idle_before_first_byte_has_no_invented_heartbeat_deadline() {
    let mut hello = hello_with_timeout(1_000);
    hello
        .frame_limits
        .as_mut()
        .expect("frame limits")
        .read_timeout_ms = 30;
    let (mut raw, host) = host_with_raw_peer(hello, 1_024).await;

    sleep(Duration::from_millis(90)).await;
    let written = host
        .command_port()
        .enqueue(cancel())
        .expect("idle actor remains writable");
    let (header, _) = timeout(Duration::from_secs(1), read_management_frame(&mut raw))
        .await
        .expect("physical frame after idle");
    assert_eq!(header.stream_seq, 2);
    assert_eq!(written.written().await.expect("written").stream_seq(), 2);
}

#[tokio::test]
async fn bounded_command_admission_is_fail_fast_and_recovers() {
    let mut hello = hello_with_timeout(1_000);
    let limits = hello.frame_limits.as_mut().expect("frame limits");
    limits.max_in_flight_bytes = limits.max_frame_bytes * 2;
    let (mut raw, host) = host_with_raw_peer(hello, 64).await;
    let port = host.command_port();

    let first = port.enqueue(query()).expect("first admission");
    let first_byte = timeout(Duration::from_secs(1), raw.read_u8())
        .await
        .expect("writer started")
        .expect("first byte");
    let second = port.enqueue(query()).expect("second admission");
    let saturated = port
        .enqueue(query())
        .expect_err("third admission must fail");
    assert!(matches!(
        saturated,
        AsyncManagementActorError::CommandQueueSaturated
    ));
    let urgent = port
        .enqueue(cancel())
        .expect("urgent reserve survives normal saturation");

    let (first_header, _) = read_management_frame_after_first(&mut raw, first_byte).await;
    assert_eq!(first_header.stream_seq, 2);
    first.written().await.expect("first write");
    let recovered = port
        .enqueue(query())
        .expect("capacity released after write");
    drop(port);

    let (urgent_header, urgent_payload) = read_management_frame(&mut raw).await;
    assert_eq!(urgent_header.stream_seq, 3);
    assert!(matches!(
        urgent_payload.body,
        Some(wire::management_payload::Body::CancelAttemptProcess(_))
    ));
    urgent.written().await.expect("urgent write");
    let (second_header, _) = read_management_frame(&mut raw).await;
    assert_eq!(second_header.stream_seq, 4);
    second.written().await.expect("second write");
    let (recovered_header, _) = read_management_frame(&mut raw).await;
    assert_eq!(recovered_header.stream_seq, 5);
    recovered.written().await.expect("recovered write");
}

#[tokio::test]
async fn host_ack_requires_an_owner_durable_commit_receipt() {
    let (mut raw, mut host) = host_with_raw_peer(hello_with_timeout(1_000), 1_024).await;
    write_established(&mut raw, sample(), 2).await;
    let event = timeout(Duration::from_secs(1), host.receive())
        .await
        .expect("host event")
        .expect("actor open")
        .expect("valid fact");
    let AsyncManagementEvent::Pending(pending) = event else {
        panic!("fact must remain pending");
    };
    assert!(matches!(
        pending.acknowledge(),
        Err(AsyncManagementActorError::DurableCommitReceiptRequired)
    ));
}

#[tokio::test]
async fn pending_resolution_has_exclusive_outbound_ordering() {
    let (mut raw, mut supervisor) =
        supervisor_with_raw_peer(hello_with_timeout(1_000), 1_024).await;
    write_established(&mut raw, query(), 2).await;
    let event = supervisor
        .receive()
        .await
        .expect("supervisor event")
        .expect("valid query");
    let AsyncManagementEvent::Pending(pending) = event else {
        panic!("query must be pending");
    };
    let queued_fact = supervisor
        .command_port()
        .enqueue(sample())
        .expect("normal fact queued");
    assert!(
        timeout(Duration::from_millis(60), raw.read_u8())
            .await
            .is_err(),
        "normal fact must not pass a pending response"
    );

    let response = pending.respond(state()).expect("response queued");
    let (response_header, response_payload) = read_management_frame(&mut raw).await;
    assert_eq!(response_header.stream_seq, 2);
    assert!(matches!(
        response_payload.body,
        Some(wire::management_payload::Body::SupervisorState(_))
    ));
    response.written().await.expect("response written");
    let (fact_header, fact_payload) = read_management_frame(&mut raw).await;
    assert_eq!(fact_header.stream_seq, 3);
    assert!(matches!(
        fact_payload.body,
        Some(wire::management_payload::Body::SupervisorResourceSample(_))
    ));
    queued_fact.written().await.expect("fact written");
}

#[tokio::test]
async fn earliest_outstanding_deadline_interrupts_a_blocked_new_write() {
    let hello = hello_with_timeout(300);
    let (mut raw, host) = host_with_raw_peer(hello, 64).await;
    let port = host.command_port();
    let first = port.enqueue(query()).expect("first query");
    let _ = read_management_frame(&mut raw).await;
    first.written().await.expect("first query written");
    sleep(Duration::from_millis(100)).await;

    let blocked = port.enqueue(query()).expect("second query admitted");
    drop(port);
    let error = timeout(Duration::from_millis(350), blocked.written())
        .await
        .expect("hard outstanding deadline")
        .expect_err("unacknowledged first query must reap blocked writer");
    assert!(matches!(
        error,
        AsyncManagementActorError::OutstandingDeadlineElapsed
    ));
}

#[tokio::test]
async fn inbound_poison_interrupts_a_blocked_write_before_commit() {
    let (mut raw, host) = host_with_raw_peer(hello_with_timeout(1_000), 64).await;
    let write = host
        .command_port()
        .enqueue(query())
        .expect("query admitted");
    let first = timeout(Duration::from_secs(1), raw.read_u8())
        .await
        .expect("writer started")
        .expect("partial outbound byte");

    raw.write_all(&[0]).await.expect("malformed zero frame");
    let error = timeout(Duration::from_millis(300), write.written())
        .await
        .expect("reader poison interrupts writer")
        .expect_err("poisoned read cannot publish a write receipt");
    assert!(matches!(error, AsyncManagementActorError::ChannelPoisoned));

    let mut partial = vec![first];
    timeout(Duration::from_secs(1), raw.read_to_end(&mut partial))
        .await
        .expect("writer half closes")
        .expect("outbound EOF");
    let (declared, prefix_len) = declared_frame_length(&partial);
    assert!(partial.len() < prefix_len + declared);
    assert!(raw.write_all(&[1, 0]).await.is_err());
}

#[tokio::test]
async fn closed_command_ports_do_not_busy_loop_or_block_inbound_reads() {
    let (mut raw, mut host) = host_with_raw_peer(hello_with_timeout(1_000), 1_024).await;
    host.close_commands_for_test();
    write_established(&mut raw, sample(), 2).await;
    let event = timeout(Duration::from_secs(1), host.receive())
        .await
        .expect("closed-port actor still polls reads")
        .expect("actor open")
        .expect("valid fact");
    assert!(matches!(event, AsyncManagementEvent::Pending(_)));
}

fn declared_frame_length(bytes: &[u8]) -> (usize, usize) {
    let mut length = 0_u32;
    for (index, byte) in bytes.iter().copied().take(5).enumerate() {
        if let Some(value) =
            crate::framing::decode_length_byte(&mut length, index, byte).expect("canonical length")
        {
            return (
                usize::try_from(value).expect("frame length fits"),
                index + 1,
            );
        }
    }
    panic!("partial output includes a complete length prefix");
}

async fn write_established(
    stream: &mut DuplexStream,
    payload: wire::ManagementPayload,
    stream_seq: u64,
) {
    let sent_at = safe_now_ms();
    let encoded = encode_management_frame(
        wire::ManagementFrameHeader {
            protocol_version: protocol().to_wire(),
            connection_id: connection().as_str().into(),
            message_id: format!("raw-message-{stream_seq}"),
            stream_seq,
            sent_at_unix_ms: sent_at,
            deadline_at_unix_ms: Some(sent_at + 1_000),
            ..wire::ManagementFrameHeader::default()
        },
        &payload,
    )
    .expect("established frame");
    write_delimited(stream, &encoded).await;
}

fn safe_now_ms() -> i64 {
    now_ms() - 250
}

async fn read_management_frame_after_first(
    stream: &mut DuplexStream,
    first: u8,
) -> (wire::ManagementFrameHeader, wire::ManagementPayload) {
    let mut length = 0_u32;
    let mut completed =
        crate::framing::decode_length_byte(&mut length, 0, first).expect("canonical first length");
    for index in 1..5 {
        if completed.is_some() {
            break;
        }
        let byte = stream.read_u8().await.expect("frame length byte");
        completed =
            crate::framing::decode_length_byte(&mut length, index, byte).expect("canonical length");
    }
    let length = completed.expect("complete frame length");
    let mut encoded = vec![0_u8; length as usize];
    stream.read_exact(&mut encoded).await.expect("frame body");
    let frame = wire::ManagementFrame::decode(encoded.as_slice()).expect("management frame");
    let payload =
        wire::ManagementPayload::decode(frame.encoded_payload.as_slice()).expect("payload");
    (frame.header.expect("frame header"), payload)
}
