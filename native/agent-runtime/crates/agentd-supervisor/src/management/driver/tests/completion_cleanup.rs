use std::sync::atomic::Ordering;
use std::time::Duration;

use super::super::completion_cleanup::MAX_COMPLETION_CLEANUP_FAILURES;
use super::super::{
    AdmissionClosureReason, CleanupStateError, SupervisorDriverStep, SupervisorPhysicalDriver,
};
use super::fakes::{FakeContainment, FakeProvisioner};
use super::support::{
    TestWriter, established, established_appendable, launch_attempt, launch_frame, peer_authority,
    trusted_runner,
};

mod online_clock;

const CLEANUP_AT: i64 = 4_000_000_000_000;

#[test]
fn completion_failure_retains_owner_until_cleanup_then_attempts_physical_reap() {
    let channel = established(
        vec![launch_frame(launch_attempt(), "launch", 2)],
        TestWriter::default(),
    );
    let (containment, state) = FakeContainment::healthy();
    let provisioner = FakeProvisioner::failing_completion();
    let cleanup = provisioner.cleanup_state();
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
        Ok(SupervisorDriverStep::LaunchRejected { .. })
    ));
    assert_eq!(driver.retained_completion_cleanups(), 1);
    assert_eq!(cleanup.attempts.load(Ordering::SeqCst), 0);
    assert_eq!(cleanup.drops.load(Ordering::SeqCst), 0);
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
    assert_eq!(state.reap_calls.load(Ordering::SeqCst), 0);
    assert_eq!(state.group_drops.load(Ordering::SeqCst), 0);
    assert!(driver.reserved_memory_bytes() > 0);

    let report = driver
        .drive_cleanup_at(CLEANUP_AT, Duration::ZERO)
        .expect("cleanup and physical reap attempt");
    assert_eq!(report.provision_cleanup_attempts, 1);
    assert_eq!(report.provision_cleanup_failures, 0);
    assert_eq!(report.reap_attempts, 1);
    assert_eq!(driver.retained_completion_cleanups(), 0);
    assert_eq!(cleanup.drops.load(Ordering::SeqCst), 1);
    assert_eq!(state.reap_calls.load(Ordering::SeqCst), 1);
    assert_eq!(state.group_drops.load(Ordering::SeqCst), 0);
    assert!(driver.reserved_memory_bytes() > 0);
}

#[test]
fn failed_completion_cleanup_retries_before_physical_reap() {
    let channel = established(
        vec![launch_frame(launch_attempt(), "launch", 2)],
        TestWriter::default(),
    );
    let (containment, state) = FakeContainment::healthy();
    let provisioner = FakeProvisioner::failing_completion_with_cleanup_failures(1);
    let cleanup = provisioner.cleanup_state();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        provisioner,
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    driver.process_next().expect("completion rejection");

    let first = driver
        .drive_cleanup_at(CLEANUP_AT, Duration::ZERO)
        .expect("first cleanup try");
    assert_eq!(first.provision_cleanup_attempts, 1);
    assert_eq!(first.provision_cleanup_failures, 1);
    assert_eq!(first.reap_attempts, 0);
    assert_eq!(driver.retained_completion_cleanups(), 1);
    assert_eq!(cleanup.drops.load(Ordering::SeqCst), 0);
    assert_eq!(state.reap_calls.load(Ordering::SeqCst), 0);

    let early = driver
        .drive_cleanup_at(CLEANUP_AT + 99, Duration::ZERO)
        .expect("before retry");
    assert_eq!(early.provision_cleanup_attempts, 0);

    let retry = driver
        .drive_cleanup_at(CLEANUP_AT + 100, Duration::ZERO)
        .expect("cleanup retry");
    assert_eq!(retry.provision_cleanup_attempts, 1);
    assert_eq!(retry.provision_cleanup_failures, 0);
    assert_eq!(retry.reap_attempts, 1);
    assert_eq!(cleanup.attempts.load(Ordering::SeqCst), 2);
    assert_eq!(cleanup.drops.load(Ordering::SeqCst), 1);
    assert_eq!(driver.retained_completion_cleanups(), 0);
}

#[test]
fn termination_failure_never_exposes_or_drops_completion_cleanup() {
    let channel = established(
        vec![launch_frame(launch_attempt(), "launch", 2)],
        TestWriter::default(),
    );
    let (containment, state) = FakeContainment::failing_termination();
    let provisioner = FakeProvisioner::failing_completion();
    let cleanup = provisioner.cleanup_state();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        provisioner,
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");

    driver.process_next().expect("completion rejection");
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
    assert_eq!(cleanup.attempts.load(Ordering::SeqCst), 0);
    assert_eq!(cleanup.drops.load(Ordering::SeqCst), 0);
    assert_eq!(driver.retained_completion_cleanups(), 1);

    let retry = driver
        .drive_cleanup_at(CLEANUP_AT, Duration::ZERO)
        .expect("termination retry remains owned");
    assert_eq!(retry.termination_attempts, 1);
    assert_eq!(retry.termination_failures, 1);
    assert_eq!(retry.provision_cleanup_attempts, 0);
    assert_eq!(retry.reap_attempts, 0);
    assert_eq!(cleanup.attempts.load(Ordering::SeqCst), 0);
    assert_eq!(cleanup.drops.load(Ordering::SeqCst), 0);
    assert_eq!(driver.retained_completion_cleanups(), 1);
}

#[test]
fn retained_cleanup_does_not_close_admission_for_another_attempt() {
    let first = launch_attempt();
    let mut second = launch_attempt();
    second.idempotency_key = "launch:second".into();
    let identity = second.identity.as_mut().expect("identity");
    identity.attempt_id = "99999999-9999-4999-8999-999999999999".into();
    identity.correlation_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into();
    let writer = TestWriter::default();
    let (channel, reader) =
        established_appendable(vec![launch_frame(first, "launch:first", 2)], writer, 2);
    let (containment, state) = FakeContainment::healthy_with_groups(2);
    let provisioner = FakeProvisioner::failing_completion();
    let prepare_calls = provisioner.calls.clone();
    let complete_calls = provisioner.complete_calls.clone();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        provisioner,
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");

    driver.process_next().expect("first rejection");
    reader.append_frame(launch_frame(second, "launch:second", 3));
    driver.process_next().expect("second rejection");

    assert!(driver.state().is_accepting_launches());
    assert_eq!(prepare_calls.load(Ordering::SeqCst), 2);
    assert_eq!(complete_calls.load(Ordering::SeqCst), 2);
    assert_eq!(state.spawn_calls.load(Ordering::SeqCst), 2);
    assert_eq!(driver.owned_attempts(), 2);
    assert_eq!(driver.retained_completion_cleanups(), 2);
}

#[test]
fn completion_failure_replay_never_reprovisions_or_duplicates_cleanup() {
    let launch = launch_attempt();
    let writer = TestWriter::default();
    let (channel, reader) = established_appendable(
        vec![launch_frame(launch.clone(), "launch:first", 2)],
        writer,
        2,
    );
    let (containment, state) = FakeContainment::healthy();
    let provisioner = FakeProvisioner::failing_completion();
    let prepare_calls = provisioner.calls.clone();
    let complete_calls = provisioner.complete_calls.clone();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        provisioner,
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");

    driver.process_next().expect("initial rejection");
    reader.append_frame(launch_frame(launch, "launch:retry", 3));
    driver.process_next().expect("registered rejection replay");

    assert_eq!(prepare_calls.load(Ordering::SeqCst), 1);
    assert_eq!(complete_calls.load(Ordering::SeqCst), 1);
    assert_eq!(state.spawn_calls.load(Ordering::SeqCst), 1);
    assert_eq!(driver.retained_completion_cleanups(), 1);
}

#[test]
fn stalled_completion_cleanup_closes_admission_and_requires_process_restart() {
    let channel = established(
        vec![launch_frame(launch_attempt(), "launch", 2)],
        TestWriter::default(),
    );
    let (containment, state) = FakeContainment::healthy();
    let provisioner = FakeProvisioner::failing_completion_with_cleanup_failures(usize::MAX);
    let cleanup = provisioner.cleanup_state();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        provisioner,
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    driver.process_next().expect("completion rejection");

    for failure in 0..u32::from(MAX_COMPLETION_CLEANUP_FAILURES - 1) {
        let observed_at = CLEANUP_AT + i64::from(failure) * 100;
        driver
            .drive_cleanup_at(observed_at, Duration::ZERO)
            .expect("bounded cleanup retry");
    }
    let stalled_at = CLEANUP_AT + i64::from(MAX_COMPLETION_CLEANUP_FAILURES - 1) * 100;
    assert_eq!(
        driver.drive_cleanup_at(stalled_at, Duration::ZERO),
        Err(CleanupStateError::BootstrapCleanupStalled)
    );
    assert_eq!(
        driver.state().closure_reason(),
        Some(AdmissionClosureReason::BootstrapCleanupStalled)
    );
    assert_eq!(
        cleanup.attempts.load(Ordering::SeqCst),
        usize::from(MAX_COMPLETION_CLEANUP_FAILURES)
    );
    assert_eq!(driver.retained_completion_cleanups(), 1);
    assert_eq!(cleanup.drops.load(Ordering::SeqCst), 0);
    assert_eq!(state.reap_calls.load(Ordering::SeqCst), 0);
    assert!(driver.reserved_memory_bytes() > 0);
}
