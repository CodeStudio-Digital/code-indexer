use std::fmt::{self, Debug, Formatter};
use std::io::{Read, Write};

use agent_platform::containment::ContainmentPort;

use super::driver::{
    CleanupDriveReport, CleanupStateError, ProtectedLaunchProvisionPort, SupervisorPhysicalDriver,
};

mod timer;
mod types;
use timer::CleanupPumpTimer;
pub use types::{
    CleanupPumpConfig, CleanupPumpConfigError, CleanupPumpOutcome, CleanupPumpStartError,
    CleanupPumpStartReason, HardRestartReason, HardRestartRequired,
};

mod sealed {
    pub trait Sealed {}
}

/// Sealed cleanup authority accepted by [`SupervisorCleanupPump`].
///
/// The production implementation is [`SupervisorPhysicalDriver`]. The trait
/// excludes management receive on purpose: the synchronous channel cannot be
/// safely polled from Tokio. A future traffic pump must hand async actor events
/// to a transport-free lifecycle core instead of cancelling reads per tick.
pub trait SupervisorCleanupOwner: sealed::Sealed {
    fn is_admission_closed(&self) -> bool;
    fn owned_attempts(&self) -> usize;
    fn pending_cleanup_count(&self) -> usize;

    /// # Errors
    ///
    /// Reports invalid cleanup state or a protected bootstrap cleanup stall.
    fn drive_cleanup_tick(&mut self) -> Result<CleanupDriveReport, CleanupStateError>;
}

impl<R, W, P, V> sealed::Sealed for SupervisorPhysicalDriver<R, W, P, V>
where
    R: Read,
    W: Write,
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
}

impl<R, W, P, V> SupervisorCleanupOwner for SupervisorPhysicalDriver<R, W, P, V>
where
    R: Read,
    W: Write,
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    fn is_admission_closed(&self) -> bool {
        !self.state().is_accepting_launches()
    }

    fn owned_attempts(&self) -> usize {
        self.owned_attempts()
    }

    fn pending_cleanup_count(&self) -> usize {
        self.state().pending_cleanup_count()
    }

    fn drive_cleanup_tick(&mut self) -> Result<CleanupDriveReport, CleanupStateError> {
        self.drive_cleanup_tick()
    }
}

/// Timer-owned cleanup drain; it never owns or restarts a management receive.
pub struct SupervisorCleanupPump<O> {
    owner: O,
    config: CleanupPumpConfig,
    timer: Option<CleanupPumpTimer>,
    outcome: Option<CleanupPumpOutcome>,
}

impl<O: SupervisorCleanupOwner> SupervisorCleanupPump<O> {
    /// Takes ownership only after admission closes and every physical attempt
    /// is already scheduled for cleanup. A healthy management owner remains
    /// with the caller even when it currently owns no attempts.
    ///
    /// # Errors
    ///
    /// Returns the untouched owner while admission is open or cleanup does not
    /// cover all attempts.
    pub fn new(owner: O, config: CleanupPumpConfig) -> Result<Self, CleanupPumpStartError<O>> {
        let owned_attempts = owner.owned_attempts();
        let scheduled_attempts = owner.pending_cleanup_count();
        let reason = if !owner.is_admission_closed() {
            Some(CleanupPumpStartReason::AdmissionOpen)
        } else if owned_attempts != scheduled_attempts {
            Some(CleanupPumpStartReason::UnscheduledOwnership)
        } else {
            None
        };
        if let Some(reason) = reason {
            return Err(CleanupPumpStartError {
                owner,
                reason,
                owned_attempts,
                scheduled_attempts,
            });
        }
        let (timer, outcome) = match CleanupPumpTimer::seal(config) {
            Ok(timer) => (Some(timer), None),
            Err(reason) => (None, Some(CleanupPumpOutcome::HardRestartRequired(reason))),
        };
        Ok(Self {
            owner,
            config,
            timer,
            outcome,
        })
    }

    /// Advances cleanup until a terminal outcome while borrowing the sole
    /// owner. Cancelling this future leaves owner, timer and deadline in the
    /// pump so the caller can resume or explicitly finish the transition.
    ///
    /// The concrete physical tick is bounded and non-blocking: it attempts at
    /// most one item per phase, polls bootstrap cleanup, and reaps with a zero
    /// timeout. The hard deadline is checked before and after every such tick.
    pub async fn advance(&mut self) -> CleanupPumpOutcome {
        if let Some(outcome) = self.outcome {
            return outcome;
        }
        if self.is_drained() {
            return self.finish(CleanupPumpOutcome::Drained);
        }
        loop {
            if self.timer_expired() {
                return self.deadline_elapsed();
            }
            if self.is_drained() {
                return self.finish(CleanupPumpOutcome::Drained);
            }
            let Some(timer) = self.timer.as_mut() else {
                return self.finish(CleanupPumpOutcome::HardRestartRequired(
                    HardRestartReason::DrainDeadlineOverflow,
                ));
            };
            let tick_ready = timer.wait_for_tick().await;
            if !tick_ready || self.timer_expired() {
                return self.deadline_elapsed();
            }
            let cleanup = self.owner.drive_cleanup_tick();
            if self.timer_expired() {
                return self.deadline_elapsed();
            }
            if let Err(error) = cleanup {
                return self.finish(CleanupPumpOutcome::HardRestartRequired(
                    HardRestartReason::CleanupState(error),
                ));
            }
            if self.is_drained() {
                return self.finish(CleanupPumpOutcome::Drained);
            }
        }
    }

    /// Consumes a cleanly drained pump and returns the original owner. A wrong
    /// transition returns the complete pump without losing ownership.
    ///
    /// # Errors
    ///
    /// Returns the intact pump unless cleanup ended in [`CleanupPumpOutcome::Drained`].
    pub fn into_owner(self) -> Result<O, Self> {
        if self.outcome == Some(CleanupPumpOutcome::Drained) {
            Ok(self.owner)
        } else {
            Err(self)
        }
    }

    /// Consumes a process-fatal outcome while retaining the owner until the
    /// caller performs the required hard restart.
    ///
    /// # Errors
    ///
    /// Returns the intact pump unless cleanup requires a hard restart.
    pub fn into_hard_restart(self) -> Result<HardRestartRequired<O>, Self> {
        let Some(CleanupPumpOutcome::HardRestartRequired(reason)) = self.outcome else {
            return Err(self);
        };
        Ok(HardRestartRequired {
            reason,
            owner: self.owner,
        })
    }

    fn is_drained(&self) -> bool {
        self.owner.owned_attempts() == 0 && self.owner.pending_cleanup_count() == 0
    }

    fn timer_expired(&self) -> bool {
        self.timer
            .as_ref()
            .is_some_and(CleanupPumpTimer::is_expired)
    }

    const fn deadline_elapsed(&mut self) -> CleanupPumpOutcome {
        self.finish(CleanupPumpOutcome::HardRestartRequired(
            HardRestartReason::DrainDeadlineElapsed,
        ))
    }

    const fn finish(&mut self, outcome: CleanupPumpOutcome) -> CleanupPumpOutcome {
        self.outcome = Some(outcome);
        outcome
    }
}

impl<O: SupervisorCleanupOwner> Debug for SupervisorCleanupPump<O> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SupervisorCleanupPump")
            .field("owned_attempts", &self.owner.owned_attempts())
            .field("scheduled_attempts", &self.owner.pending_cleanup_count())
            .field("config", &self.config)
            .field("timer_started", &self.timer.is_some())
            .field("outcome", &self.outcome)
            .finish()
    }
}

#[cfg(test)]
mod tests;
