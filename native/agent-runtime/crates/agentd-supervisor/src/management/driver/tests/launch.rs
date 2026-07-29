use std::ffi::OsString;
use std::sync::atomic::Ordering;
use std::time::Duration;

use agent_protocol::management_channel::ManagementChannelError;

use super::super::{
    SupervisorDriverError, SupervisorDriverStep, SupervisorPhysicalDriver, TrustedRunnerConfig,
    TrustedRunnerConfigError,
};
use super::fakes::{FakeContainment, FakeProvisioner};
use super::support::{
    TestWriter, ack_frame_for_output, decoded_frames, established, established_appendable,
    launch_attempt, launch_frame, peer_authority, trusted_runner,
};

#[test]
fn exact_transport_retry_replays_response_without_respawn() {
    let frame = launch_frame(launch_attempt(), "launch", 2);
    let writer = TestWriter::default();
    let channel = established(vec![frame.clone(), frame], writer.clone());
    let (containment, state) = FakeContainment::healthy();
    let provisioner = FakeProvisioner::successful();
    let provision_calls = provisioner.calls.clone();
    let complete_calls = provisioner.complete_calls.clone();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        provisioner,
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");

    assert!(matches!(
        driver.process_next(),
        Ok(SupervisorDriverStep::LaunchAccepted {
            reused_existing: false
        })
    ));
    assert_eq!(
        driver.process_next().expect("exact replay"),
        SupervisorDriverStep::Replay
    );
    assert_eq!(state.spawn_calls.load(Ordering::SeqCst), 1);
    assert_eq!(provision_calls.load(Ordering::SeqCst), 1);
    assert_eq!(complete_calls.load(Ordering::SeqCst), 1);
    let frames = decoded_frames(&writer);
    assert_eq!(frames.len(), 3);
    assert_eq!(frames[1], frames[2]);
}

#[test]
fn semantic_retry_with_changed_payload_is_rejected_as_stale_without_respawn() {
    let first = launch_attempt();
    let mut changed_launch = first.clone();
    changed_launch.idempotency_key = "launch:changed".into();
    changed_launch.launch_nonce = vec![7; 32];
    let channel = established(
        vec![
            launch_frame(first, "launch-1", 2),
            launch_frame(changed_launch, "launch-2", 3),
        ],
        TestWriter::default(),
    );
    let (containment, state) = FakeContainment::healthy();
    let provisioner = FakeProvisioner::successful();
    let provision_calls = provisioner.calls.clone();
    let complete_calls = provisioner.complete_calls.clone();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        provisioner,
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");

    assert!(matches!(
        driver.process_next(),
        Ok(SupervisorDriverStep::LaunchAccepted { .. })
    ));
    assert_eq!(
        driver.process_next().expect("stale rejection"),
        SupervisorDriverStep::LaunchRejected {
            reason_code: "SUPERVISOR_DUPLICATE_CONFLICT"
        }
    );
    assert_eq!(state.spawn_calls.load(Ordering::SeqCst), 1);
    assert_eq!(provision_calls.load(Ordering::SeqCst), 1);
    assert_eq!(complete_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn spawned_fact_write_failure_terminates_and_remains_nondurable_until_reap() {
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

    assert!(matches!(
        driver.process_next(),
        Ok(SupervisorDriverStep::LaunchAccepted { .. })
    ));
    writer.fail_on_next_write();
    reader.append_frame(ack_frame_for_output(&writer, 1, "ack:accepted", 3));
    assert!(matches!(
        driver.process_next(),
        Err(SupervisorDriverError::Channel(
            ManagementChannelError::Framing(_)
        ))
    ));
    assert!(!driver.state().is_accepting_launches());
    assert_eq!(state.spawn_calls.load(Ordering::SeqCst), 1);
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
    assert_eq!(driver.owned_attempts(), 1);
    assert!(driver.reserved_memory_bytes() > 0);
    assert_eq!(
        driver.launch_registry.state_for_test("launch:test"),
        Some((0, false, true, false, false))
    );

    let report = driver
        .drive_cleanup(Duration::ZERO)
        .expect("reap timeout is retained");
    assert_eq!(report.reap_attempts, 1);
    assert_eq!(report.reaped, 0);
    assert_eq!(report.retained_for_reap, 1);
    assert_eq!(state.group_drops.load(Ordering::SeqCst), 0);
    assert!(driver.reserved_memory_bytes() > 0);
    assert_eq!(
        driver.launch_registry.state_for_test("launch:test"),
        Some((0, false, true, false, false))
    );
}

#[test]
fn trusted_config_rejects_credential_shaped_environment_keys() {
    let trusted = trusted_runner();
    let root = std::env::current_dir().expect("test current directory");
    let result = TrustedRunnerConfig::new(
        root.join("runner.exe"),
        root.join("work"),
        vec![(OsString::from("API_TOKEN"), OsString::from("secret"))],
        trusted.provenance().clone(),
    );

    assert_eq!(result, Err(TrustedRunnerConfigError::InvalidEnvironmentKey));
}
