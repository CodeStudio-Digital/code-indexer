use std::cell::RefCell;
use std::time::{Duration, Instant};

use agent_platform::containment::ChildHandleAllowlist;
use agent_platform::windows::bootstrap::{
    ProductionWindowsBootstrapReader, ProductionWindowsBootstrapWriter, WindowsBootstrapCleanup,
    prepare_production_windows_bootstrap,
};
use agent_protocol::runner_bootstrap::{
    SupervisorPhysicalBootstrapSender, prepare_runner_launch_handoff,
};

use super::completion::{
    ProtectedLaunchCleanupOwner, ProtectedLaunchCleanupPort, ProtectedLaunchCleanupProof,
    ProtectedLaunchCompletion,
};
use super::deadline::EffectiveBootstrapDeadline;
use super::staged::{
    PendingProtectedLaunch, PreparedProtectedLaunch, ProtectedLaunchPhysicalFacts,
};
use super::{ProtectedLaunchProvisionPort, ProtectedLaunchRequest};

mod cancellation;
mod cleanup;
mod error;
mod handoff;
mod io;

pub use cancellation::WindowsProtectedLaunchCancellation;
pub use cleanup::WindowsProtectedLaunchCleanup;
pub use error::WindowsProtectedLaunchError;

use cancellation::{CancellationRegistry, WindowsBootstrapCancellationRegistration};
use handoff::build_windows_handoff;
use io::{OverlappedBootstrapReader, OverlappedBootstrapWriter};

const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(15);

/// Production Windows provisioner for the one-shot supervisor-runner handoff.
pub struct WindowsProtectedLaunchProvisioner {
    startup_timeout: Duration,
    cancellations: CancellationRegistry,
}

/// Linear provider state retained from endpoint preparation through completion.
pub struct PendingWindowsProtectedLaunch {
    reader: Option<ProductionWindowsBootstrapReader>,
    writer: Option<ProductionWindowsBootstrapWriter>,
    cancellation: WindowsBootstrapCancellationRegistration,
    deadline: EffectiveBootstrapDeadline,
}

impl std::fmt::Debug for WindowsProtectedLaunchProvisioner {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WindowsProtectedLaunchProvisioner")
            .field("startup_timeout", &self.startup_timeout)
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for PendingWindowsProtectedLaunch {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PendingWindowsProtectedLaunch")
            .field("bootstrap", &"[OWNED; PROTECTED]")
            .finish_non_exhaustive()
    }
}

impl Default for WindowsProtectedLaunchProvisioner {
    fn default() -> Self {
        Self::new(DEFAULT_STARTUP_TIMEOUT).expect("default startup timeout is non-zero")
    }
}

impl WindowsProtectedLaunchProvisioner {
    /// Creates a provisioner whose complete bootstrap shares one monotonic cap.
    ///
    /// # Errors
    ///
    /// Rejects a zero startup timeout.
    pub fn new(startup_timeout: Duration) -> Result<Self, WindowsProtectedLaunchError> {
        if startup_timeout.is_zero() {
            return Err(WindowsProtectedLaunchError::InvalidStartupTimeout);
        }
        Ok(Self {
            startup_timeout,
            cancellations: CancellationRegistry::new(),
        })
    }

    /// Returns revocation authority for the currently prepared bootstrap.
    #[must_use]
    pub fn cancellation_handle(&self) -> WindowsProtectedLaunchCancellation {
        self.cancellations.handle()
    }

    const fn failure(
        error: WindowsProtectedLaunchError,
        cleanups: Vec<WindowsBootstrapCleanup>,
    ) -> ProtectedLaunchCompletion<WindowsProtectedLaunchCleanup, WindowsProtectedLaunchError> {
        ProtectedLaunchCompletion::cleanup_required(
            error,
            ProtectedLaunchCleanupOwner::new(WindowsProtectedLaunchCleanup::new(cleanups)),
        )
    }
}

impl ProtectedLaunchProvisionPort for WindowsProtectedLaunchProvisioner {
    type Pending = PendingWindowsProtectedLaunch;
    type Cleanup = WindowsProtectedLaunchCleanup;
    type Error = WindowsProtectedLaunchError;

    fn prepare(
        &self,
        request: &ProtectedLaunchRequest<'_>,
    ) -> Result<PreparedProtectedLaunch<Self::Pending>, Self::Error> {
        let observed_at = Instant::now();
        let observed_at_unix_ms = error::now_unix_ms()?;
        let deadline = EffectiveBootstrapDeadline::derive(
            observed_at_unix_ms,
            observed_at,
            request.hard_deadline_at_unix_ms(),
            request.authority_lease_expires_at_unix_ms(),
            self.startup_timeout,
        )
        .map_err(|_| WindowsProtectedLaunchError::EffectiveDeadline)?;
        let cancellation = self.cancellations.register()?;
        let prepared = prepare_production_windows_bootstrap()
            .map_err(|_| WindowsProtectedLaunchError::BootstrapPrepare)?;
        let (parent, child_stdio) = prepared.into_parts();
        let (reader, writer) = parent.into_parts();
        let mut child_handles = ChildHandleAllowlist::new();
        child_handles
            .install_windows_bootstrap(child_stdio)
            .map_err(|_| WindowsProtectedLaunchError::ChildHandleAllowlist)?;
        Ok(PreparedProtectedLaunch::new(
            request,
            child_handles,
            PendingWindowsProtectedLaunch {
                reader: Some(reader),
                writer: Some(writer),
                cancellation,
                deadline,
            },
        ))
    }

    fn complete_after_spawn(
        &self,
        mut pending: PendingProtectedLaunch<Self::Pending>,
        physical: &ProtectedLaunchPhysicalFacts,
    ) -> ProtectedLaunchCompletion<Self::Cleanup, Self::Error> {
        let deadline = pending.provider().deadline;
        let handoff = build_windows_handoff(pending.handoff_facts(), physical);
        let Ok(prepared) = prepare_runner_launch_handoff(handoff) else {
            return Self::failure(WindowsProtectedLaunchError::Handoff, Vec::new());
        };
        let Some(reader) = pending.provider_mut().reader.take() else {
            return Self::failure(WindowsProtectedLaunchError::InvalidState, Vec::new());
        };
        let Some(writer) = pending.provider_mut().writer.take() else {
            return Self::failure(WindowsProtectedLaunchError::InvalidState, Vec::new());
        };
        let cleanups = RefCell::new(Vec::new());
        let cancellation = pending.provider().cancellation.observer();
        let sender = SupervisorPhysicalBootstrapSender::new(
            OverlappedBootstrapReader::new(reader, deadline.instant(), cancellation, &cleanups),
            OverlappedBootstrapWriter::new(writer, deadline.instant(), cancellation, &cleanups),
        );
        let awaiting = match sender.send_owned(prepared) {
            Ok(value) => value,
            Err(failure) => {
                let (reader, writer, error) = failure.into_parts();
                drop((reader, writer));
                return Self::failure(
                    WindowsProtectedLaunchError::HandoffSend(error),
                    cleanups.into_inner(),
                );
            }
        };
        let ready = match awaiting.receive_owned() {
            Ok(value) => value,
            Err(failure) => {
                let (reader, error) = failure.into_parts();
                drop(reader);
                return Self::failure(
                    WindowsProtectedLaunchError::ReadyReceive(error),
                    cleanups.into_inner(),
                );
            }
        };
        if !cleanups.borrow().is_empty() {
            return Self::failure(
                WindowsProtectedLaunchError::InvalidState,
                cleanups.into_inner(),
            );
        }
        let completed_at = Instant::now();
        let completed_at_unix_ms = match error::now_unix_ms() {
            Ok(value) => value,
            Err(error) => return Self::failure(error, Vec::new()),
        };
        if !deadline.permits_completion(completed_at_unix_ms, completed_at) {
            return Self::failure(WindowsProtectedLaunchError::AuthorityExpired, Vec::new());
        }
        ProtectedLaunchCompletion::completed(pending.mint_receipt(physical, ready))
    }
}

impl ProtectedLaunchCleanupPort for WindowsProtectedLaunchCleanup {
    type Error = WindowsProtectedLaunchError;

    fn try_cleanup(&mut self) -> Result<ProtectedLaunchCleanupProof, Self::Error> {
        self.try_cleanup()
    }
}

#[cfg(test)]
mod tests;
