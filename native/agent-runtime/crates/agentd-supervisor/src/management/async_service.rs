//! Permanent owner that composes asynchronous management with physical cleanup.
//!
//! The protocol actor remains the only stream reader/writer. This service owns
//! that actor beside the transport-free lifecycle core and serializes every
//! management transition with every physical timer tick.

use agent_platform::containment::ContainmentPort;
use agent_protocol::management_channel::{
    AsyncEstablishedManagementActor, AsyncManagementActorError,
};

use super::driver::{
    CleanupDriveReport, CleanupStateError, ProtectedLaunchProvisionPort, SupervisorDriverError,
    SupervisorDriverStep, SupervisorLifecycleCore,
};
use super::{
    OnlineLifecycleShutdownHandle, SupervisorLifecycleClock, SupervisorOnlineLifecycle,
    SupervisorOnlineLifecycleTimer,
};

mod dispatch;
mod launch;
mod service_loop;
mod shutdown;
mod terminal;
mod write;

use launch::PendingServiceLaunch;
use write::PendingServiceWrite;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisorAsyncServiceStatus {
    Online,
    Draining,
    HardRestartRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisorManagementTerminal {
    Shutdown,
    PeerClosed,
    ReadFailure,
    WriteFailure,
    ProtocolFailure,
    UnsupportedInbound(&'static str),
}

#[derive(Debug)]
pub enum SupervisorAsyncServiceAdvance<P> {
    Cleanup(CleanupDriveReport),
    ShutdownArmed,
    Replay,
    LaunchResolved(SupervisorDriverStep),
    TerminationScheduled(SupervisorDriverStep),
    ManagementAcknowledged,
    ChannelDraining(AsyncManagementActorError),
    DriverFailure(SupervisorDriverError<P>),
    HardRestartRequired(CleanupStateError),
}

#[derive(Debug)]
pub enum SupervisorAsyncServiceOutcome<P, V>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    PhysicallyDrained {
        owner: SupervisorLifecycleCore<P, V>,
        terminal: SupervisorManagementTerminal,
    },
    HardRestartRequired {
        owner: SupervisorLifecycleCore<P, V>,
        error: CleanupStateError,
    },
}

#[derive(Debug)]
enum ServiceMode {
    Online,
    Draining(SupervisorManagementTerminal),
    HardRestart(CleanupStateError),
}

/// Unique owner of the established management actor and physical lifecycle.
#[derive(Debug)]
pub struct SupervisorAsyncService<P, V, C, T>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
    C: SupervisorLifecycleClock,
    T: SupervisorOnlineLifecycleTimer,
{
    actor: AsyncEstablishedManagementActor,
    lifecycle: SupervisorOnlineLifecycle<SupervisorLifecycleCore<P, V>, C, T>,
    pending_launch: Option<PendingServiceLaunch<P, V>>,
    pending_write: Option<PendingServiceWrite>,
    mode: ServiceMode,
}

impl<P, V, C, T> SupervisorAsyncService<P, V, C, T>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
    C: SupervisorLifecycleClock,
    T: SupervisorOnlineLifecycleTimer,
{
    #[must_use]
    pub fn new(
        actor: AsyncEstablishedManagementActor,
        owner: SupervisorLifecycleCore<P, V>,
        clock: C,
        timer: T,
    ) -> (OnlineLifecycleShutdownHandle, Self) {
        let (shutdown, lifecycle) = SupervisorOnlineLifecycle::new(owner, clock, timer);
        (
            shutdown,
            Self {
                actor,
                lifecycle,
                pending_launch: None,
                pending_write: None,
                mode: ServiceMode::Online,
            },
        )
    }

    #[must_use]
    pub const fn status(&self) -> SupervisorAsyncServiceStatus {
        match self.mode {
            ServiceMode::Online => SupervisorAsyncServiceStatus::Online,
            ServiceMode::Draining(_) => SupervisorAsyncServiceStatus::Draining,
            ServiceMode::HardRestart(_) => SupervisorAsyncServiceStatus::HardRestartRequired,
        }
    }

    #[must_use]
    pub const fn owner(&self) -> &SupervisorLifecycleCore<P, V> {
        self.lifecycle.owner()
    }

    fn physically_drained(&self) -> bool {
        self.pending_write.is_none()
            && self.pending_launch.is_none()
            && self.owner().owned_attempts() == 0
            && self.owner().state().pending_cleanup_count() == 0
    }

    #[cfg(test)]
    pub(crate) const fn has_pending_write(&self) -> bool {
        self.pending_write.is_some()
    }

    #[cfg(test)]
    pub(crate) const fn has_pending_launch(&self) -> bool {
        self.pending_launch.is_some()
    }
}
