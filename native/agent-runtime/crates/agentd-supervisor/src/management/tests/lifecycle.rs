use std::io::{self, Cursor, Write};
use std::sync::atomic::{AtomicUsize, Ordering};

use agent_protocol::frame::CONTROL_FRAME_MAX_BYTES;
use agent_protocol::generated::v1 as wire;
use agent_protocol::identity::ConnectionId;
use agent_protocol::management_channel::{
    ManagementChannelError, ManagementReceiveOutcome, ManagementReplayLimits,
};

use super::{
    CONNECTION, RecordingWriter, TOKEN, deadline, delimit, frame, host_hello, launch_accepted,
    launch_attempt, launch_receipt,
};
use crate::management::SupervisorManagementBootstrap;

fn bootstrap<W: Write>(
    extra_frames: Vec<Vec<u8>>,
    writer: W,
) -> SupervisorManagementBootstrap<Cursor<Vec<u8>>, W> {
    let mut frames = vec![frame(
        wire::management_payload::Body::HostSupervisorHello(host_hello()),
        "host-bootstrap",
        1,
    )];
    frames.extend(extra_frames);
    SupervisorManagementBootstrap::new(
        Cursor::new(delimit(&frames)),
        writer,
        ConnectionId::new(CONNECTION).expect("connection"),
        TOKEN.to_vec(),
        launch_receipt(),
    )
    .expect("bootstrap")
}

fn launch_frame() -> Vec<u8> {
    frame(
        wire::management_payload::Body::LaunchAttemptProcess(launch_attempt()),
        "launch",
        2,
    )
}

fn replay_limits() -> ManagementReplayLimits {
    ManagementReplayLimits::new(4, 16, 256 * 1024).expect("limits")
}

#[test]
fn facade_enforces_physical_hello_order() {
    let mut invalid = bootstrap(Vec::new(), RecordingWriter::default());
    assert!(matches!(
        invalid.send_supervisor_hello(),
        Err(ManagementChannelError::WrongBootstrapOrder)
    ));
    assert!(invalid.is_poisoned());

    let writer = RecordingWriter::default();
    let mut valid = bootstrap(Vec::new(), writer.clone());
    assert!(writer.bytes().is_empty());
    valid.receive_host_hello().expect("receive first");
    assert!(writer.bytes().is_empty());
    valid.send_supervisor_hello().expect("send second");
    assert!(!writer.bytes().is_empty());
}

#[test]
fn consumed_launch_receipt_poisons_repeated_supervisor_hello() {
    let mut bootstrap = bootstrap(Vec::new(), RecordingWriter::default());
    bootstrap.receive_host_hello().expect("host hello");
    bootstrap.send_supervisor_hello().expect("first hello");

    assert!(matches!(
        bootstrap.send_supervisor_hello(),
        Err(ManagementChannelError::BootstrapConsumed)
    ));
    assert!(bootstrap.is_poisoned());
}

#[test]
fn facade_established_eof_poison_is_observable() {
    let mut bootstrap = bootstrap(Vec::new(), RecordingWriter::default());
    bootstrap.receive_host_hello().expect("host hello");
    bootstrap.send_supervisor_hello().expect("supervisor hello");
    let mut channel = bootstrap
        .into_established(replay_limits())
        .expect("handoff");

    assert!(matches!(
        channel.begin_receive(),
        Err(ManagementChannelError::UnexpectedEof)
    ));
    assert!(channel.is_poisoned());
}

#[test]
fn structurally_incomplete_launch_never_becomes_pending_work() {
    let invalid = frame(
        wire::management_payload::Body::LaunchAttemptProcess(wire::LaunchAttemptProcess::default()),
        "invalid-launch",
        2,
    );
    let mut bootstrap = bootstrap(vec![invalid], RecordingWriter::default());
    bootstrap.receive_host_hello().expect("host hello");
    bootstrap.send_supervisor_hello().expect("supervisor hello");
    let mut channel = bootstrap
        .into_established(replay_limits())
        .expect("handoff");

    assert!(matches!(
        channel.begin_receive(),
        Err(ManagementChannelError::InvalidManagementPayload {
            payload: "LaunchAttemptProcess",
            ..
        })
    ));
    assert!(channel.is_poisoned());
}

#[test]
fn facade_write_failure_returns_no_receipt_and_poisons() {
    let mut bootstrap = bootstrap(vec![launch_frame()], FailWriter::new(3));
    bootstrap.receive_host_hello().expect("host hello");
    bootstrap.send_supervisor_hello().expect("supervisor hello");
    let mut channel = bootstrap
        .into_established(replay_limits())
        .expect("handoff");
    let Some(ManagementReceiveOutcome::Pending(inbound)) = channel.begin_receive().expect("launch")
    else {
        panic!("expected launch");
    };
    let response = wire::ManagementPayload {
        body: Some(wire::management_payload::Body::LaunchAccepted(
            launch_accepted(&launch_attempt()),
        )),
    };

    assert!(matches!(
        channel.commit_response(*inbound, &response, deadline()),
        Err(ManagementChannelError::Framing(_))
    ));
    assert!(channel.is_poisoned());
}

#[test]
fn facade_preserves_single_use_pending_across_handoff() {
    let mut bootstrap = bootstrap(vec![launch_frame()], RecordingWriter::default());
    bootstrap.receive_host_hello().expect("host hello");
    bootstrap.send_supervisor_hello().expect("supervisor hello");
    let mut channel = bootstrap
        .into_established(replay_limits())
        .expect("handoff");
    let Some(ManagementReceiveOutcome::Pending(mut inbound)) =
        channel.begin_receive().expect("launch")
    else {
        panic!("expected launch");
    };

    let (validated, _) = inbound
        .take_validated_payload_and_digest()
        .expect("first take");
    assert!(validated.launch_attempt_process().is_some());
    assert!(matches!(
        inbound.take_validated_payload_and_digest(),
        Err(ManagementChannelError::PendingPayloadConsumed)
    ));
    let response = wire::ManagementPayload {
        body: Some(wire::management_payload::Body::LaunchAccepted(
            launch_accepted(&launch_attempt()),
        )),
    };
    channel
        .commit_response(*inbound, &response, deadline())
        .expect("binding remains valid");
}

#[test]
fn pending_and_channel_debug_redact_launch_and_endpoint_secrets() {
    let mut launch = launch_attempt();
    launch.launch_nonce = b"launch-nonce-never-debug".to_vec();
    launch.protected_endpoints[0] = wire::ProtectedAttemptEndpoint {
        kind: wire::AttemptEndpointKind::Control as i32,
        endpoint_id: "endpoint:test".into(),
        address: "secret-pipe-address-never-debug".into(),
        connection_token: b"endpoint-token-never-debug".to_vec(),
        max_frame_bytes: CONTROL_FRAME_MAX_BYTES as u64,
        connection_id: "connection:redaction-test".into(),
    };
    let inbound = frame(
        wire::management_payload::Body::LaunchAttemptProcess(launch),
        "launch-with-secrets",
        2,
    );
    let mut bootstrap = bootstrap(vec![inbound], RecordingWriter::default());
    bootstrap.receive_host_hello().expect("host hello");
    bootstrap.send_supervisor_hello().expect("supervisor hello");
    let mut channel = bootstrap
        .into_established(replay_limits())
        .expect("handoff");
    let outcome = channel.begin_receive().expect("launch").expect("frame");
    let rendered = format!("{outcome:?} {channel:?}");

    assert!(rendered.contains("LaunchAttemptProcess"));
    assert!(rendered.contains("[REDACTED]"));
    assert!(!rendered.contains("launch-nonce-never-debug"));
    assert!(!rendered.contains("secret-pipe-address-never-debug"));
    assert!(!rendered.contains("endpoint-token-never-debug"));
}

#[derive(Debug)]
struct FailWriter {
    calls: AtomicUsize,
    fail_at: usize,
}

impl FailWriter {
    const fn new(fail_at: usize) -> Self {
        Self {
            calls: AtomicUsize::new(0),
            fail_at,
        }
    }
}

impl Write for FailWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        if call >= self.fail_at {
            Err(io::Error::other("injected facade write failure"))
        } else {
            Ok(bytes.len())
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
