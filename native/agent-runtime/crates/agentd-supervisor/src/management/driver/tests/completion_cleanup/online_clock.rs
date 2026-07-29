use std::sync::atomic::Ordering;

use crate::management::driver::tests::fakes::{
    FakeContainment, FakeProvisioner, ManualLifecycleClock,
};
use crate::management::driver::tests::support::{
    TestWriter, established, launch_attempt, launch_frame, peer_authority, trusted_runner,
};
use crate::management::{SupervisorLifecycleOwner, SupervisorPhysicalDriver};
use crate::process_table::PhysicalState;

const NOW: i64 = 4_102_444_699_800;

#[test]
fn provision_cleanup_retry_is_scheduled_from_the_post_effect_clock_sample() {
    let launch = launch_attempt();
    let channel = established(
        vec![launch_frame(launch, "launch", 2)],
        TestWriter::default(),
    );
    let (containment, containment_state) = FakeContainment::healthy();
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
    driver.process_next_at(NOW).expect("completion rejection");
    let clock = ManualLifecycleClock::new(NOW);
    cleanup.advance_clock_on_next_cleanup(clock.clone(), NOW + 50);

    let report = SupervisorLifecycleOwner::drive_cleanup_tick(&mut driver, &clock)
        .expect("post-effect retry remains owned");

    assert_eq!(report.provision_cleanup_attempts, 1);
    assert_eq!(report.provision_cleanup_failures, 1);
    assert_eq!(cleanup.attempts.load(Ordering::SeqCst), 1);
    assert_eq!(cleanup.drops.load(Ordering::SeqCst), 0);
    assert_eq!(containment_state.reap_calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        SupervisorLifecycleOwner::next_cleanup_deadline_unix_ms(&driver),
        Some(NOW + 150)
    );
    assert_eq!(driver.owned_attempts(), 1);
    assert!(driver.reserved_memory_bytes() > 0);
    assert_eq!(
        driver.physical_state_for_test("launch:test"),
        Some(PhysicalState::Cancelling)
    );
}
