use std::sync::atomic::Ordering;
use std::time::Duration;

use agent_protocol::management_channel::ManagementChannelError;

use super::super::{SupervisorDriverError, SupervisorPhysicalDriver};
use super::fakes::{FakeContainment, FakeProvisioner};
use super::support::{
    TestWriter, ack_frame_for_output, established_appendable, launch_attempt, launch_frame,
    peer_authority, trusted_runner,
};

#[test]
fn accepted_write_failure_never_marks_the_owned_intent_durable_or_evictable() {
    let writer = TestWriter::default();
    let (channel, _reader) = established_appendable(
        vec![launch_frame(launch_attempt(), "launch", 2)],
        writer.clone(),
        1,
    );
    let (containment, state) = FakeContainment::healthy();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::successful(),
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    writer.fail_on_next_write();

    assert!(matches!(
        driver.process_next(),
        Err(SupervisorDriverError::Channel(
            ManagementChannelError::Framing(_)
        ))
    ));
    assert_eq!(state.spawn_calls.load(Ordering::SeqCst), 1);
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        driver.launch_registry.state_for_test("launch:test"),
        Some((0, false, true, false, false))
    );
}

#[test]
fn containment_write_failure_never_marks_the_owned_intent_durable_or_evictable() {
    let writer = TestWriter::default();
    let (channel, reader) = established_appendable(
        vec![launch_frame(launch_attempt(), "launch", 2)],
        writer.clone(),
        1,
    );
    let (containment, state) = FakeContainment::healthy();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::successful(),
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    driver.process_next().expect("launch");
    reader.append_frame(ack_frame_for_output(&writer, 1, "ack:accepted", 3));
    driver.process_next().expect("accepted ack");
    writer.fail_on_next_write();
    reader.append_frame(ack_frame_for_output(&writer, 2, "ack:spawned", 4));

    assert!(matches!(
        driver.process_next(),
        Err(SupervisorDriverError::Channel(
            ManagementChannelError::Framing(_)
        ))
    ));
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        driver.launch_registry.state_for_test("launch:test"),
        Some((0, false, true, false, false))
    );

    let report = driver
        .drive_cleanup(Duration::ZERO)
        .expect("reap timeout is retained");
    assert_eq!(report.reap_attempts, 1);
    assert_eq!(report.reaped, 0);
    assert_eq!(
        driver.launch_registry.state_for_test("launch:test"),
        Some((0, false, true, false, false))
    );
}
