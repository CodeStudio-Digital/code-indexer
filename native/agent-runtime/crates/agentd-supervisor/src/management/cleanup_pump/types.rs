use std::error::Error;
use std::fmt::{self, Debug, Display, Formatter};
use std::time::Duration;

use super::CleanupStateError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CleanupPumpConfig {
    pub(super) tick_interval: Duration,
    pub(super) hard_timeout: Duration,
}

impl CleanupPumpConfig {
    /// # Errors
    ///
    /// Both durations must be non-zero and the tick interval cannot exceed the
    /// hard timeout.
    pub const fn new(
        tick_interval: Duration,
        hard_timeout: Duration,
    ) -> Result<Self, CleanupPumpConfigError> {
        if tick_interval.is_zero() {
            return Err(CleanupPumpConfigError::ZeroTickInterval);
        }
        if hard_timeout.is_zero() {
            return Err(CleanupPumpConfigError::ZeroHardTimeout);
        }
        if tick_interval.as_nanos() > hard_timeout.as_nanos() {
            return Err(CleanupPumpConfigError::TickExceedsHardTimeout);
        }
        Ok(Self {
            tick_interval,
            hard_timeout,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupPumpConfigError {
    ZeroTickInterval,
    ZeroHardTimeout,
    TickExceedsHardTimeout,
}

impl Display for CleanupPumpConfigError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid supervisor cleanup pump config: {self:?}"
        )
    }
}

impl Error for CleanupPumpConfigError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HardRestartReason {
    CleanupState(CleanupStateError),
    DrainDeadlineElapsed,
    DrainDeadlineOverflow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupPumpOutcome {
    Drained,
    HardRestartRequired(HardRestartReason),
}

/// Typed process-fatal outcome that keeps physical ownership alive.
#[must_use = "hard restart ownership must remain alive until process termination"]
pub struct HardRestartRequired<O> {
    pub(super) reason: HardRestartReason,
    pub(super) owner: O,
}

impl<O> HardRestartRequired<O> {
    #[must_use]
    pub const fn reason(&self) -> HardRestartReason {
        self.reason
    }

    #[must_use]
    pub const fn owner(&self) -> &O {
        &self.owner
    }

    #[must_use]
    pub fn into_owner(self) -> O {
        self.owner
    }
}

impl<O> Debug for HardRestartRequired<O> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HardRestartRequired")
            .field("reason", &self.reason)
            .finish_non_exhaustive()
    }
}

/// Start rejection returns the untouched owner instead of losing containment.
#[must_use = "rejected cleanup ownership must be recovered"]
pub struct CleanupPumpStartError<O> {
    pub(super) owner: O,
    pub(super) reason: CleanupPumpStartReason,
    pub(super) owned_attempts: usize,
    pub(super) scheduled_attempts: usize,
}

impl<O> CleanupPumpStartError<O> {
    #[must_use]
    pub const fn reason(&self) -> CleanupPumpStartReason {
        self.reason
    }

    #[must_use]
    pub const fn owned_attempts(&self) -> usize {
        self.owned_attempts
    }

    #[must_use]
    pub const fn scheduled_attempts(&self) -> usize {
        self.scheduled_attempts
    }

    #[must_use]
    pub fn into_owner(self) -> O {
        self.owner
    }
}

impl<O> Debug for CleanupPumpStartError<O> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CleanupPumpStartError")
            .field("reason", &self.reason)
            .field("owned_attempts", &self.owned_attempts)
            .field("scheduled_attempts", &self.scheduled_attempts)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupPumpStartReason {
    AdmissionOpen,
    UnscheduledOwnership,
}
