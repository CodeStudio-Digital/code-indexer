use std::io::Cursor;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::framing::{DelimitedFrameChannel, DelimitedFrameCodec, FramingError};
use crate::generated::v1 as wire;
use crate::management_channel::{
    BootstrapManagementChannel, ManagementBootstrapHello, ManagementChannelError,
    ManagementDirection,
};
use crate::management_frame::MANAGEMENT_FRAME_MAX_BYTES;

use super::support::{
    CONNECTION, MANAGEMENT_TOKEN, NOW, ObservedRead, RecordingWriter, SUPERVISOR_NONCE, connection,
    decode_delimited, decode_frame, delimited, frame, frame_with_context, hard_cap_u32, host_hello,
    protocol, supervisor_bootstrap_frame, supervisor_hello,
};

fn bootstrap<R: std::io::Read, W: std::io::Write>(
    reader: R,
    writer: W,
    direction: ManagementDirection,
) -> BootstrapManagementChannel<R, W> {
    let codec = DelimitedFrameCodec::new(hard_cap_u32()).expect("codec");
    BootstrapManagementChannel::new(
        DelimitedFrameChannel::new(codec, reader, writer),
        connection(),
        SUPERVISOR_NONCE.to_vec(),
        MANAGEMENT_TOKEN.to_vec(),
        direction,
    )
    .expect("bootstrap")
}

#[test]
fn supervisor_receives_host_hello_before_sending_its_hello_on_same_stream() {
    let inbound = frame(
        wire::management_payload::Body::HostSupervisorHello(host_hello()),
        "host-bootstrap",
        1,
    );
    let writer = RecordingWriter::default();
    let mut channel = bootstrap(
        Cursor::new(delimited(&[inbound])),
        writer.clone(),
        ManagementDirection::HostToSupervisor,
    );

    assert!(matches!(
        channel.receive_with_clock(|| NOW + 1).expect("host hello"),
        ManagementBootstrapHello::HostSupervisorAccepted
    ));
    channel
        .send_supervisor_hello_with_clock(&supervisor_hello(), || NOW + 2)
        .expect("supervisor hello");
    channel
        .into_established(super::support::limits())
        .expect("same-stream handoff");

    let output = decode_delimited(&writer.bytes());
    assert_eq!(output.len(), 1);
    let (header, payload) = decode_frame(&output[0]);
    assert_eq!(header.connection_id, CONNECTION);
    assert_eq!(header.stream_seq, 1);
    assert!(matches!(
        payload.body,
        Some(wire::management_payload::Body::SupervisorHello(_))
    ));
}

#[test]
fn host_must_send_hello_before_receiving_supervisor_hello() {
    let mut channel = bootstrap(
        Cursor::new(delimited(&[supervisor_bootstrap_frame()])),
        RecordingWriter::default(),
        ManagementDirection::SupervisorToHost,
    );

    assert!(matches!(
        channel.receive_with_clock(|| NOW + 1),
        Err(ManagementChannelError::WrongBootstrapOrder)
    ));
}

#[test]
fn supervisor_cannot_send_hello_before_receiving_host_selection() {
    let mut channel = bootstrap(
        Cursor::new(Vec::new()),
        RecordingWriter::default(),
        ManagementDirection::HostToSupervisor,
    );

    assert!(matches!(
        channel.send_supervisor_hello_with_clock(&supervisor_hello(), || NOW),
        Err(ManagementChannelError::WrongBootstrapOrder)
    ));
}

#[test]
fn bootstrap_rejects_connection_mismatch_and_wrong_hello_direction() {
    let foreign = frame_with_context(
        wire::management_payload::Body::SupervisorHello(supervisor_hello()),
        "foreign-supervisor",
        1,
        protocol(),
        "management:foreign",
        None,
    );
    let mut host = bootstrap(
        Cursor::new(delimited(&[foreign])),
        RecordingWriter::default(),
        ManagementDirection::SupervisorToHost,
    );
    host.send_host_hello_with_clock(&host_hello(), || NOW)
        .expect("host hello");
    assert!(matches!(
        host.receive_with_clock(|| NOW + 1),
        Err(ManagementChannelError::ConnectionMismatch)
    ));

    let wrong = supervisor_bootstrap_frame();
    let mut supervisor = bootstrap(
        Cursor::new(delimited(&[wrong])),
        RecordingWriter::default(),
        ManagementDirection::HostToSupervisor,
    );
    assert!(matches!(
        supervisor.receive_with_clock(|| NOW + 1),
        Err(ManagementChannelError::WrongBootstrapPayload)
    ));
}

#[test]
fn physical_cap_rejects_before_decode_and_before_clock_sampling() {
    let oversized_prefix = vec![0x81, 0x80, 0x04];
    let called = Arc::new(AtomicBool::new(false));
    let mut channel = bootstrap(
        Cursor::new(oversized_prefix),
        RecordingWriter::default(),
        ManagementDirection::HostToSupervisor,
    );
    let called_by_clock = Arc::clone(&called);
    let error = channel
        .receive_with_clock(|| {
            called_by_clock.store(true, Ordering::SeqCst);
            NOW
        })
        .expect_err("oversized declaration");

    assert!(!called.load(Ordering::SeqCst));
    assert!(matches!(
        error,
        ManagementChannelError::Framing(FramingError::FrameTooLarge {
            declared,
            maximum
        }) if declared == 65_537 && maximum == 65_536
    ));
}

#[test]
fn receive_clock_is_sampled_after_the_physical_read() {
    let inbound = frame(
        wire::management_payload::Body::HostSupervisorHello(host_hello()),
        "host-bootstrap",
        1,
    );
    let observed = Arc::new(AtomicBool::new(false));
    let reader = ObservedRead::new(delimited(&[inbound]), Arc::clone(&observed));
    let mut channel = bootstrap(
        reader,
        RecordingWriter::default(),
        ManagementDirection::HostToSupervisor,
    );

    channel
        .receive_with_clock(|| {
            assert!(observed.load(Ordering::SeqCst));
            NOW + 1
        })
        .expect("clock after read");
}

#[test]
fn physical_bootstrap_cap_must_be_exactly_sixty_four_kib() {
    let codec = DelimitedFrameCodec::new(1024).expect("codec");
    let transport =
        DelimitedFrameChannel::new(codec, Cursor::new(Vec::new()), RecordingWriter::default());

    assert!(matches!(
        BootstrapManagementChannel::new(
            transport,
            connection(),
            SUPERVISOR_NONCE.to_vec(),
            MANAGEMENT_TOKEN.to_vec(),
            ManagementDirection::HostToSupervisor
        ),
        Err(ManagementChannelError::PhysicalCapMismatch {
            physical: 1024,
            required: MANAGEMENT_FRAME_MAX_BYTES
        })
    ));
}
