use std::io::Cursor;

use agent_protocol::generated::v1 as wire;
use agent_protocol::identity::ConnectionId;
use agent_protocol::management_channel::{ManagementReceiveOutcome, ManagementReplayLimits};
use agent_protocol::management_frame::validate_management_frame;

use super::{SupervisorLaunchReceipt, SupervisorManagementBootstrap};

mod lifecycle;
mod support;

use support::*;

#[test]
fn private_clock_owner_survives_bootstrap_handoff_and_established_response() {
    let launch = launch_attempt();
    let input = delimit(&[
        frame(
            wire::management_payload::Body::HostSupervisorHello(host_hello()),
            "host-bootstrap",
            1,
        ),
        frame(
            wire::management_payload::Body::LaunchAttemptProcess(launch.clone()),
            "launch",
            2,
        ),
    ]);
    let writer = RecordingWriter::default();
    let mut bootstrap = SupervisorManagementBootstrap::new(
        Cursor::new(input),
        writer.clone(),
        ConnectionId::new(CONNECTION).expect("connection"),
        TOKEN.to_vec(),
        launch_receipt(),
    )
    .expect("bootstrap");

    bootstrap.receive_host_hello().expect("host hello");
    bootstrap.send_supervisor_hello().expect("supervisor hello");
    let mut channel = bootstrap
        .into_established(ManagementReplayLimits::new(4, 16, 256 * 1024).expect("limits"))
        .expect("handoff");
    let Some(ManagementReceiveOutcome::Pending(inbound)) = channel.begin_receive().expect("launch")
    else {
        panic!("expected pending launch");
    };
    let response = wire::ManagementPayload {
        body: Some(wire::management_payload::Body::LaunchAccepted(
            launch_accepted(&launch),
        )),
    };
    channel
        .commit_response(*inbound, &response, deadline())
        .expect("launch response");

    let frames = decode_delimited(&writer.bytes());
    assert_eq!(frames.len(), 2);
    let first = validate_management_frame(&frames[0]).expect("supervisor hello");
    let second = validate_management_frame(&frames[1]).expect("launch accepted");
    let first_header = first.frame.header.clone().expect("header");
    let header = second.frame.header.clone().expect("header");
    assert!(first_header.sent_at_unix_ms > 0);
    assert!(header.sent_at_unix_ms >= first_header.sent_at_unix_ms);
    assert_eq!(
        header.deadline_at_unix_ms,
        Some(header.sent_at_unix_ms + 250)
    );
    assert_eq!(header.stream_seq, 2);
    assert_eq!(header.reply_to_message_id.as_deref(), Some("launch"));
}

#[test]
fn launch_receipt_debug_redacts_the_preprovisioned_nonce() {
    let nonce = b"receipt-nonce-never-debug".to_vec();
    let receipt = SupervisorLaunchReceipt::new(
        wire::ProtocolVersionRange {
            minimum: Some(version()),
            maximum: Some(version()),
        },
        "supervisor-build".into(),
        "commit".into(),
        vec![1; 32],
        "runtime:one".into(),
        "windows".into(),
        "x86_64".into(),
        wire::ContainmentCapabilities::default(),
        0,
        nonce,
    )
    .expect("receipt");
    let rendered = format!("{receipt:?}");

    assert!(rendered.contains("[REDACTED]"));
    assert!(!rendered.contains("receipt-nonce-never-debug"));
}
