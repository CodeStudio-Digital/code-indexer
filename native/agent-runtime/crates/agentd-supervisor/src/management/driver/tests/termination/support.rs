use std::io::Cursor;
use std::sync::Arc;

use agent_protocol::generated::v1 as wire;
use agent_protocol::management_frame::{encode_management_frame, validate_management_frame};

use super::super::fakes::{ContainmentState, FakeContainment, FakeProvisioner};
use super::super::support::{
    TestWriter, established, frame, launch_attempt, launch_frame, peer_authority, trusted_runner,
};
use crate::management::driver::SupervisorPhysicalDriver;

pub(in crate::management::driver::tests) const NOW: i64 = 4_102_444_699_800;
pub(super) const GRACE: i64 = NOW + 80;
pub(super) const FENCE_DUE: i64 = NOW + 100;
pub(super) const LEASE_DEADLINE: i64 = 4_102_444_700_000;

pub(super) type TestDriver =
    SupervisorPhysicalDriver<Cursor<Vec<u8>>, TestWriter, FakeContainment, FakeProvisioner>;

pub(super) fn cancel(identity: wire::AttemptIdentity) -> wire::CancelAttemptProcess {
    wire::CancelAttemptProcess {
        identity: Some(identity),
        grace_deadline_at_unix_ms: GRACE,
        reason_code: "user.cancelled".into(),
        idempotency_key: "cancel:test".into(),
    }
}

pub(super) fn launch_identity() -> wire::AttemptIdentity {
    launch_attempt().identity.expect("launch identity")
}

pub(super) fn fence(identity: wire::AttemptIdentity) -> wire::FenceAttemptProcess {
    let replacement_fencing_epoch = identity.fencing_epoch + 1;
    wire::FenceAttemptProcess {
        identity: Some(identity),
        replacement_fencing_epoch,
        reason_code: "authority.replaced".into(),
        fenced_at_unix_ms: 1,
        idempotency_key: "fence:test".into(),
    }
}

pub(in crate::management::driver::tests) fn reap(
    identity: wire::AttemptIdentity,
) -> wire::ReapAttemptProcess {
    wire::ReapAttemptProcess {
        identity: Some(identity),
        runtime_instance_id: runtime_instance_id(),
        reap_deadline_at_unix_ms: NOW + 500,
        reason_code: "terminal.committed".into(),
        idempotency_key: "reap:test".into(),
    }
}

pub(in crate::management::driver::tests) fn lifecycle_frame(
    body: wire::management_payload::Body,
    message_id: &str,
    sequence: u64,
) -> Vec<u8> {
    frame(body, message_id, sequence)
}

pub(super) fn launched_with(
    commands: Vec<Vec<u8>>,
    writer: TestWriter,
) -> (TestDriver, Arc<ContainmentState>, wire::AttemptIdentity) {
    let launch = launch_attempt();
    launched_from(launch, commands, writer, 1)
}

pub(super) fn launched_with_termination_failure(
    commands: Vec<Vec<u8>>,
) -> (TestDriver, Arc<ContainmentState>, wire::AttemptIdentity) {
    let launch = launch_attempt();
    let identity = launch.identity.clone().expect("launch identity");
    let mut frames = vec![launch_frame(launch, "launch", 2)];
    frames.extend(commands);
    let channel = established(frames, TestWriter::default());
    let (containment, state) = FakeContainment::failing_termination();
    let driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::successful(),
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    (driver, state, identity)
}

pub(super) fn launched_from(
    launch: wire::LaunchAttemptProcess,
    commands: Vec<Vec<u8>>,
    writer: TestWriter,
    group_count: usize,
) -> (TestDriver, Arc<ContainmentState>, wire::AttemptIdentity) {
    let identity = launch.identity.clone().expect("launch identity");
    let mut frames = vec![launch_frame(launch, "launch", 2)];
    frames.extend(commands);
    let channel = established(frames, writer);
    let (containment, state) = FakeContainment::healthy_with_groups(group_count);
    let driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::successful(),
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    (driver, state, identity)
}

pub(super) fn launch(driver: &mut TestDriver) {
    driver.process_next_at(1_000).expect("launch");
}

pub(super) fn launched_pair_with_cancel() -> (TestDriver, Arc<ContainmentState>) {
    let first = launch_attempt();
    let first_identity = first.identity.clone().expect("first identity");
    let mut second = first.clone();
    second
        .identity
        .as_mut()
        .expect("second identity")
        .attempt_id = "99999999-9999-4999-8999-999999999999".into();
    second.idempotency_key = "launch:second".into();
    second.launch_nonce[0] = 9;
    let frames = vec![
        launch_frame(first, "launch:first", 2),
        launch_frame(second, "launch:second", 3),
        lifecycle_frame(
            wire::management_payload::Body::CancelAttemptProcess(cancel(first_identity)),
            "cancel:first",
            4,
        ),
    ];
    let channel = established(frames, TestWriter::default());
    let (containment, state) = FakeContainment::healthy_with_groups(2);
    let driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::successful(),
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    (driver, state)
}

pub(super) fn launched_pair_with_reap() -> (TestDriver, Arc<ContainmentState>) {
    let first = launch_attempt();
    let first_identity = first.identity.clone().expect("first identity");
    let mut second = first.clone();
    second
        .identity
        .as_mut()
        .expect("second identity")
        .attempt_id = "99999999-9999-4999-8999-999999999999".into();
    second.idempotency_key = "launch:second".into();
    second.launch_nonce[0] = 9;
    let frames = vec![
        launch_frame(first, "launch:first", 2),
        launch_frame(second, "launch:second", 3),
        lifecycle_frame(
            wire::management_payload::Body::ReapAttemptProcess(reap(first_identity)),
            "reap:first",
            4,
        ),
    ];
    let channel = established(frames, TestWriter::default());
    let (containment, state) = FakeContainment::healthy_with_groups(2);
    let driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::successful(),
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    (driver, state)
}

pub(super) fn launched_pair_reusing_a_termination_key() -> TestDriver {
    let first = launch_attempt();
    let first_identity = first.identity.clone().expect("first identity");
    let mut second = first.clone();
    let second_identity = second.identity.as_mut().expect("second identity");
    second_identity.attempt_id = "99999999-9999-4999-8999-999999999999".into();
    let second_identity = second_identity.clone();
    second.idempotency_key = "launch:second".into();
    second.launch_nonce[0] = 9;
    let frames = vec![
        launch_frame(first, "launch:first", 2),
        launch_frame(second, "launch:second", 3),
        lifecycle_frame(
            wire::management_payload::Body::CancelAttemptProcess(cancel(first_identity)),
            "cancel:first",
            4,
        ),
        lifecycle_frame(
            wire::management_payload::Body::CancelAttemptProcess(cancel(second_identity)),
            "cancel:second",
            5,
        ),
    ];
    let channel = established(frames, TestWriter::default());
    let (containment, _) = FakeContainment::healthy_with_groups(2);
    SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::successful(),
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver")
}

fn runtime_instance_id() -> String {
    let plan = launch_attempt();
    let payload = wire::ManagementPayload {
        body: Some(wire::management_payload::Body::LaunchAttemptProcess(plan)),
    };
    let encoded = encode_management_frame(wire::ManagementFrameHeader::default(), &payload)
        .expect("encoded launch payload");
    let validated = validate_management_frame(&encoded).expect("validated launch payload");
    let digest: [u8; 32] = validated
        .frame
        .header
        .as_ref()
        .expect("management header")
        .payload_sha256
        .as_slice()
        .try_into()
        .expect("payload digest");
    format!("runtime:{}", hex_prefix(&digest, 16))
}

fn hex_prefix(bytes: &[u8; 32], count: usize) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(count * 2);
    for byte in bytes.iter().take(count) {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}
