use std::time::Duration;

use super::sealed;
use super::{
    CleanupDriveReport, CleanupPumpConfig, CleanupPumpConfigError, CleanupPumpOutcome,
    CleanupStateError, HardRestartReason, SupervisorCleanupOwner, SupervisorCleanupPump,
};

mod timing;

#[derive(Debug)]
struct FakeOwner {
    owned: usize,
    scheduled: usize,
    admission_closed: bool,
    drain_after: Option<usize>,
    failure: Option<CleanupStateError>,
    tick_delay: Duration,
    ticks: usize,
}

impl FakeOwner {
    const fn draining(drain_after: usize) -> Self {
        Self {
            owned: 1,
            scheduled: 1,
            admission_closed: true,
            drain_after: Some(drain_after),
            failure: None,
            tick_delay: Duration::ZERO,
            ticks: 0,
        }
    }

    const fn stalled(failure: Option<CleanupStateError>) -> Self {
        Self {
            owned: 1,
            scheduled: 1,
            admission_closed: true,
            drain_after: None,
            failure,
            tick_delay: Duration::ZERO,
            ticks: 0,
        }
    }

    const fn delayed_tick(delay: Duration) -> Self {
        Self {
            owned: 1,
            scheduled: 1,
            admission_closed: true,
            drain_after: Some(1),
            failure: None,
            tick_delay: delay,
            ticks: 0,
        }
    }
}

impl sealed::Sealed for FakeOwner {}

impl SupervisorCleanupOwner for FakeOwner {
    fn is_admission_closed(&self) -> bool {
        self.admission_closed
    }

    fn owned_attempts(&self) -> usize {
        self.owned
    }

    fn pending_cleanup_count(&self) -> usize {
        self.scheduled
    }

    fn drive_cleanup_tick(&mut self) -> Result<CleanupDriveReport, CleanupStateError> {
        std::thread::sleep(self.tick_delay);
        self.ticks += 1;
        if let Some(error) = self.failure {
            return Err(error);
        }
        if self.drain_after == Some(self.ticks) {
            self.owned = 0;
            self.scheduled = 0;
        }
        Ok(CleanupDriveReport::default())
    }
}

#[test]
fn config_rejects_unbounded_zero_and_misaligned_intervals() {
    assert_eq!(
        CleanupPumpConfig::new(Duration::ZERO, Duration::from_secs(1)),
        Err(CleanupPumpConfigError::ZeroTickInterval)
    );
    assert_eq!(
        CleanupPumpConfig::new(Duration::from_millis(1), Duration::ZERO),
        Err(CleanupPumpConfigError::ZeroHardTimeout)
    );
    assert_eq!(
        CleanupPumpConfig::new(Duration::from_secs(2), Duration::from_secs(1)),
        Err(CleanupPumpConfigError::TickExceedsHardTimeout)
    );
}

#[test]
fn start_rejection_returns_unscheduled_owner() {
    let owner = FakeOwner {
        owned: 2,
        scheduled: 1,
        admission_closed: true,
        drain_after: None,
        failure: None,
        tick_delay: Duration::ZERO,
        ticks: 0,
    };
    let config =
        CleanupPumpConfig::new(Duration::from_millis(1), Duration::from_secs(1)).expect("config");
    let rejection = SupervisorCleanupPump::new(owner, config).expect_err("unscheduled ownership");

    assert_eq!(rejection.owned_attempts(), 2);
    assert_eq!(rejection.scheduled_attempts(), 1);
    assert_eq!(rejection.into_owner().ticks, 0);
}

#[test]
fn open_admission_is_rejected_even_without_physical_ownership() {
    let owner = FakeOwner {
        owned: 0,
        scheduled: 0,
        admission_closed: false,
        drain_after: None,
        failure: None,
        tick_delay: Duration::ZERO,
        ticks: 0,
    };
    let config =
        CleanupPumpConfig::new(Duration::from_millis(1), Duration::from_secs(1)).expect("config");
    let rejection = SupervisorCleanupPump::new(owner, config).expect_err("admission remains open");

    assert_eq!(
        rejection.reason(),
        super::CleanupPumpStartReason::AdmissionOpen
    );
    assert!(!rejection.into_owner().admission_closed);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn timer_drains_without_threads_or_management_traffic() {
    let config =
        CleanupPumpConfig::new(Duration::from_millis(10), Duration::from_secs(1)).expect("config");
    let mut pump =
        SupervisorCleanupPump::new(FakeOwner::draining(3), config).expect("fully scheduled");

    assert_eq!(pump.advance().await, CleanupPumpOutcome::Drained);
    let owner = pump.into_owner().expect("drained owner");
    assert_eq!(owner.ticks, 3);
    assert_eq!(owner.owned, 0);
    assert_eq!(owner.scheduled, 0);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn cleanup_stall_requires_hard_restart_and_preserves_owner() {
    let config =
        CleanupPumpConfig::new(Duration::from_millis(10), Duration::from_secs(1)).expect("config");
    let mut pump = SupervisorCleanupPump::new(
        FakeOwner::stalled(Some(CleanupStateError::BootstrapCleanupStalled)),
        config,
    )
    .expect("fully scheduled");

    assert_eq!(
        pump.advance().await,
        CleanupPumpOutcome::HardRestartRequired(HardRestartReason::CleanupState(
            CleanupStateError::BootstrapCleanupStalled
        ))
    );
    let restart = pump.into_hard_restart().expect("hard restart");
    assert_eq!(
        restart.reason(),
        HardRestartReason::CleanupState(CleanupStateError::BootstrapCleanupStalled)
    );
    assert_eq!(restart.owner().owned, 1);
    assert_eq!(restart.owner().scheduled, 1);
    assert_eq!(restart.owner().ticks, 1);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn hard_deadline_never_converts_retained_owner_into_success() {
    let config = CleanupPumpConfig::new(Duration::from_millis(10), Duration::from_millis(25))
        .expect("config");
    let mut pump =
        SupervisorCleanupPump::new(FakeOwner::stalled(None), config).expect("fully scheduled");

    assert_eq!(
        pump.advance().await,
        CleanupPumpOutcome::HardRestartRequired(HardRestartReason::DrainDeadlineElapsed)
    );
    let restart = pump.into_hard_restart().expect("deadline restart");
    assert_eq!(restart.reason(), HardRestartReason::DrainDeadlineElapsed);
    assert_eq!(restart.owner().owned, 1);
    assert_eq!(restart.owner().scheduled, 1);
    assert_eq!(restart.owner().ticks, 3);
}
