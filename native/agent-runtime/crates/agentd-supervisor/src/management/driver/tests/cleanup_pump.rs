use std::sync::atomic::Ordering;
use std::time::Duration;

use agent_protocol::management_channel::ManagementChannelError;

use crate::management::{
    CleanupPumpConfig, CleanupPumpOutcome, CleanupPumpStartReason, HardRestartReason,
    SupervisorCleanupPump, SupervisorDriverError, SupervisorDriverStep, SupervisorPhysicalDriver,
};

use super::fakes::{FakeContainment, FakeProvisioner};
use super::support::{
    TestWriter, established, launch_attempt, launch_frame, peer_authority, trusted_runner,
};

mod shutdown;

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn eof_driver_is_retained_until_nonblocking_reap_or_hard_restart() {
    let channel = established(
        vec![launch_frame(launch_attempt(), "launch", 2)],
        TestWriter::default(),
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
        driver.process_next_at(1_000),
        Ok(SupervisorDriverStep::LaunchAccepted { .. })
    ));
    assert!(matches!(
        driver.process_next_at(2_000),
        Err(SupervisorDriverError::Channel(
            ManagementChannelError::UnexpectedEof
        ))
    ));

    let config =
        CleanupPumpConfig::new(Duration::from_millis(1), Duration::from_millis(5)).expect("config");
    let mut pump =
        SupervisorCleanupPump::new(driver, config).expect("all EOF ownership is scheduled");

    assert_eq!(
        pump.advance().await,
        CleanupPumpOutcome::HardRestartRequired(HardRestartReason::DrainDeadlineElapsed)
    );
    let restart = pump.into_hard_restart().expect("fake reap remains pending");
    assert_eq!(restart.reason(), HardRestartReason::DrainDeadlineElapsed);
    assert_eq!(restart.owner().owned_attempts(), 1);
    assert_eq!(restart.owner().state().pending_cleanup_count(), 1);
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
    assert_eq!(state.reap_calls.load(Ordering::SeqCst), 1);
    assert_eq!(state.group_drops.load(Ordering::SeqCst), 0);
}

#[test]
fn active_watchdog_does_not_make_an_open_driver_transferable_to_cleanup_pump() {
    let channel = established(
        vec![launch_frame(launch_attempt(), "launch", 2)],
        TestWriter::default(),
    );
    let (containment, _state) = FakeContainment::healthy();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::successful(),
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    driver.process_next_at(1_000).expect("launch");
    let config =
        CleanupPumpConfig::new(Duration::from_millis(1), Duration::from_secs(1)).expect("config");

    let rejection =
        SupervisorCleanupPump::new(driver, config).expect_err("active admission remains open");

    assert_eq!(rejection.owned_attempts(), 1);
    assert_eq!(rejection.scheduled_attempts(), 1);
    assert_eq!(rejection.reason(), CleanupPumpStartReason::AdmissionOpen);
    assert_eq!(rejection.into_owner().owned_attempts(), 1);
}

#[test]
fn cleanup_tick_is_bounded_to_one_attempt_per_phase() {
    let first = launch_attempt();
    let mut second = first.clone();
    second.identity.as_mut().expect("identity").attempt_id =
        "99999999-9999-4999-8999-999999999999".into();
    second.idempotency_key = "launch:second".into();
    second.launch_nonce[0] = 9;
    let channel = established(
        vec![
            launch_frame(first, "launch:first", 2),
            launch_frame(second, "launch:second", 3),
        ],
        TestWriter::default(),
    );
    let (containment, state) = FakeContainment::healthy_with_groups(2);
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::failing_completion(),
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    driver.process_next_at(1_000).expect("first rejection");
    driver.process_next_at(1_001).expect("second rejection");

    let first_tick = driver.drive_cleanup_tick().expect("bounded cleanup tick");

    assert_eq!(first_tick.provision_cleanup_attempts, 1);
    assert_eq!(first_tick.reap_attempts, 1);
    assert_eq!(state.reap_calls.load(Ordering::SeqCst), 1);
    assert_eq!(driver.owned_attempts(), 2);

    let second_tick = driver.drive_cleanup_tick().expect("fair next cleanup tick");
    assert_eq!(second_tick.provision_cleanup_attempts, 1);
    assert_eq!(second_tick.reap_attempts, 1);
    assert_eq!(state.reap_calls.load(Ordering::SeqCst), 2);
}

#[test]
fn retrying_first_reap_rotates_behind_other_due_attempts() {
    let first = launch_attempt();
    let mut second = first.clone();
    second.identity.as_mut().expect("identity").attempt_id =
        "99999999-9999-4999-8999-999999999999".into();
    second.idempotency_key = "launch:second".into();
    second.launch_nonce[0] = 9;
    let channel = established(
        vec![
            launch_frame(first, "launch:first", 2),
            launch_frame(second, "launch:second", 3),
        ],
        TestWriter::default(),
    );
    let (containment, state) = FakeContainment::healthy_with_groups(2);
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::failing_completion(),
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    driver.process_next_at(1_000).expect("first rejection");
    driver.process_next_at(1_001).expect("second rejection");

    let first_tick = i64::MAX - 300;
    driver
        .drive_cleanup_tick_at(first_tick)
        .expect("first cleanup tick");
    driver
        .drive_cleanup_tick_at(first_tick + 100)
        .expect("first retry remains due");
    driver
        .drive_cleanup_tick_at(first_tick + 200)
        .expect("round-robin reaches second attempt");

    let reaped = {
        let reaped = state.reaped_group_ids.lock().expect("reaped group IDs");
        assert_eq!(reaped.len(), 3);
        [reaped[0], reaped[1], reaped[2]]
    };
    assert_eq!(reaped[0], reaped[1]);
    assert_ne!(reaped[0], reaped[2]);
}
