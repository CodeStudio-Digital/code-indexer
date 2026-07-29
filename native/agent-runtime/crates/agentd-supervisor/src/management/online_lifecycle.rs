//! Transport-free online lifecycle timer.
//!
//! This owner is deliberately separate from the management stream. A product
//! loop may select [`SupervisorOnlineLifecycle::advance`] beside
//! `AsyncEstablishedManagementActor::receive` without duplicating stream
//! ownership or making cleanup depend on another inbound frame.

use std::fmt::{self, Debug, Formatter};
use std::future::pending;
use std::time::Duration;

use tokio::sync::mpsc;

use super::{CleanupDriveReport, CleanupStateError};

mod clock;
mod owner;
mod shutdown;
mod timer;

pub use clock::{
    SupervisorLifecycleClock, SupervisorLifecycleClockError, SystemSupervisorLifecycleClock,
};
pub use shutdown::{
    OnlineLifecycleShutdown, OnlineLifecycleShutdownError, OnlineLifecycleShutdownHandle,
};
pub use timer::{SupervisorOnlineLifecycleTimer, TokioSupervisorLifecycleTimer};

mod sealed {
    pub trait Sealed {}
}

/// Sole physical lifecycle owner used by the online timer.
///
/// Implementations remain transport-free: management validation and stream
/// sequencing belong to the protocol actor, while this owner retains resource
/// groups, reservations, cleanup schedules, and their physical effects.
pub trait SupervisorLifecycleOwner: sealed::Sealed {
    /// Earliest physical deadline or retry that can change lifecycle state.
    fn next_cleanup_deadline_unix_ms(&self) -> Option<i64>;

    /// Advances bounded physical work and re-samples `clock` around every
    /// effect before changing or publishing the resulting state.
    ///
    /// # Errors
    ///
    /// Returns a fail-closed cleanup state error while retaining ownership.
    fn drive_cleanup_tick(
        &mut self,
        clock: &dyn SupervisorLifecycleClock,
    ) -> Result<CleanupDriveReport, CleanupStateError>;

    /// Closes admission and schedules every owner no later than `shutdown`.
    ///
    /// # Errors
    ///
    /// Invalid time or lifecycle state fails closed without dropping owners.
    fn begin_shutdown(
        &mut self,
        shutdown: OnlineLifecycleShutdown,
        clock: &dyn SupervisorLifecycleClock,
    ) -> Result<(), CleanupStateError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnlineLifecycleAdvance {
    Cleanup(CleanupDriveReport),
    ShutdownArmed,
    HardRestartRequired(CleanupStateError),
}

/// Cancel-safe owner of online cleanup deadlines and the bounded shutdown wake.
///
/// `advance` performs one bounded transition. Cancelling the returned future
/// leaves the owner, timer, shutdown queue, and original deadlines in `self`.
/// A surrounding permanent task repeatedly selects it beside management actor
/// events.
pub struct SupervisorOnlineLifecycle<O, C, T> {
    owner: O,
    clock: C,
    timer: T,
    shutdown: mpsc::Receiver<OnlineLifecycleShutdown>,
    shutdown_open: bool,
}

impl<O, C, T> SupervisorOnlineLifecycle<O, C, T>
where
    O: SupervisorLifecycleOwner,
    C: SupervisorLifecycleClock,
    T: SupervisorOnlineLifecycleTimer,
{
    #[must_use]
    pub fn new(owner: O, clock: C, timer: T) -> (OnlineLifecycleShutdownHandle, Self) {
        let (shutdown, receiver) = mpsc::channel(1);
        (
            OnlineLifecycleShutdownHandle::new(shutdown),
            Self {
                owner,
                clock,
                timer,
                shutdown: receiver,
                shutdown_open: true,
            },
        )
    }

    pub async fn advance(&mut self) -> OnlineLifecycleAdvance {
        loop {
            let now = self.clock.now_unix_ms();
            if now <= 0 {
                return OnlineLifecycleAdvance::HardRestartRequired(CleanupStateError::InvalidTime);
            }
            let deadline = self.owner.next_cleanup_deadline_unix_ms();
            match self.wait_for_wake(now, deadline).await {
                LifecycleWake::Deadline => {
                    return match self.owner.drive_cleanup_tick(&self.clock) {
                        Ok(report) => OnlineLifecycleAdvance::Cleanup(report),
                        Err(error) => OnlineLifecycleAdvance::HardRestartRequired(error),
                    };
                }
                LifecycleWake::Shutdown(shutdown) => {
                    return match self.owner.begin_shutdown(shutdown, &self.clock) {
                        Ok(()) => OnlineLifecycleAdvance::ShutdownArmed,
                        Err(error) => OnlineLifecycleAdvance::HardRestartRequired(error),
                    };
                }
                LifecycleWake::ShutdownSenderClosed => {
                    self.shutdown_open = false;
                }
            }
        }
    }

    #[must_use]
    pub const fn owner(&self) -> &O {
        &self.owner
    }

    pub(in crate::management) const fn owner_mut(&mut self) -> &mut O {
        &mut self.owner
    }

    pub(in crate::management) const fn owner_and_clock_mut(&mut self) -> (&mut O, &C) {
        (&mut self.owner, &self.clock)
    }

    pub(in crate::management) fn owner_now_unix_ms(&self) -> i64 {
        self.clock.now_unix_ms()
    }

    #[must_use]
    pub fn into_owner(self) -> O {
        self.owner
    }

    async fn wait_for_wake(
        &mut self,
        now_unix_ms: i64,
        deadline_at_unix_ms: Option<i64>,
    ) -> LifecycleWake {
        let deadline_wait = wait_duration(now_unix_ms, deadline_at_unix_ms);
        if deadline_wait.is_some_and(|delay| delay.is_zero()) {
            return LifecycleWake::Deadline;
        }
        match (deadline_wait, self.shutdown_open) {
            (Some(delay), true) => {
                tokio::select! {
                    biased;
                    request = self.shutdown.recv() => request.map_or(
                        LifecycleWake::ShutdownSenderClosed,
                        LifecycleWake::Shutdown,
                    ),
                    () = self.timer.wait(delay) => LifecycleWake::Deadline,
                }
            }
            (Some(delay), false) => {
                self.timer.wait(delay).await;
                LifecycleWake::Deadline
            }
            (None, true) => self
                .shutdown
                .recv()
                .await
                .map_or(LifecycleWake::ShutdownSenderClosed, LifecycleWake::Shutdown),
            (None, false) => pending::<LifecycleWake>().await,
        }
    }
}

impl<O: Debug, C: Debug, T: Debug> Debug for SupervisorOnlineLifecycle<O, C, T> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SupervisorOnlineLifecycle")
            .field("owner", &self.owner)
            .field("clock", &self.clock)
            .field("timer", &self.timer)
            .field("shutdown_open", &self.shutdown_open)
            .finish_non_exhaustive()
    }
}

enum LifecycleWake {
    Deadline,
    Shutdown(OnlineLifecycleShutdown),
    ShutdownSenderClosed,
}

fn wait_duration(now_unix_ms: i64, deadline_at_unix_ms: Option<i64>) -> Option<Duration> {
    let deadline = deadline_at_unix_ms?;
    let remaining = deadline.saturating_sub(now_unix_ms);
    Some(Duration::from_millis(
        u64::try_from(remaining).unwrap_or_default(),
    ))
}

#[cfg(test)]
mod tests;
