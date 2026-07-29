use std::fmt::{self, Debug, Formatter};

use super::receipt::ProtectedLaunchReceipt;

/// Provider-owned cleanup operation retained after a failed protected handoff.
pub trait ProtectedLaunchCleanupPort {
    type Error;

    /// Polls cleanup without blocking and proves that every completion-side
    /// resource can now be released.
    ///
    /// Implementations must perform bounded, immediately cancellable work.
    /// Waiting for process exit or I/O completion belongs to the outer reaper.
    ///
    /// # Errors
    ///
    /// Returns a provider error while retaining the same cleanup owner for a
    /// later retry.
    fn try_cleanup(&mut self) -> Result<ProtectedLaunchCleanupProof, Self::Error>;
}

/// Opaque evidence returned only after completion-side cleanup succeeds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[must_use = "cleanup proof must gate the transition to physical reap"]
pub struct ProtectedLaunchCleanupProof {
    _private: (),
}

impl ProtectedLaunchCleanupProof {
    /// Creates cleanup evidence at the trusted provider boundary.
    pub(in crate::management::driver) const fn completed() -> Self {
        Self { _private: () }
    }
}

/// Linear owner of resources that outlive a failed completion attempt.
#[must_use = "dropping cleanup ownership can block or strand bootstrap resources"]
pub struct ProtectedLaunchCleanupOwner<C> {
    cleanup: C,
}

impl<C> ProtectedLaunchCleanupOwner<C> {
    /// Wraps cleanup authority without exposing it back to the coordinator.
    pub const fn new(cleanup: C) -> Self {
        Self { cleanup }
    }

    pub(in crate::management::driver) fn map<D>(
        self,
        transform: impl FnOnce(C) -> D,
    ) -> ProtectedLaunchCleanupOwner<D> {
        ProtectedLaunchCleanupOwner::new(transform(self.cleanup))
    }

    pub(in crate::management::driver) fn cleanup<E>(
        &mut self,
    ) -> Result<ProtectedLaunchCleanupProof, E>
    where
        C: ProtectedLaunchCleanupPort<Error = E>,
    {
        self.cleanup.try_cleanup()
    }
}

impl<C> Debug for ProtectedLaunchCleanupOwner<C> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProtectedLaunchCleanupOwner([REDACTED])")
    }
}

/// Completion failure that cannot be separated from its cleanup authority.
#[must_use = "completion failure must be retained with its cleanup owner"]
pub struct ProtectedLaunchCompletionFailure<C, E> {
    error: E,
    cleanup: ProtectedLaunchCleanupOwner<C>,
}

impl<C, E> ProtectedLaunchCompletionFailure<C, E> {
    pub(in crate::management::driver) const fn new(
        error: E,
        cleanup: ProtectedLaunchCleanupOwner<C>,
    ) -> Self {
        Self { error, cleanup }
    }

    pub(in crate::management::driver) fn into_parts(self) -> (E, ProtectedLaunchCleanupOwner<C>) {
        (self.error, self.cleanup)
    }
}

impl<C, E> Debug for ProtectedLaunchCompletionFailure<C, E> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProtectedLaunchCompletionFailure([REDACTED])")
    }
}

/// Typed completion outcome: failure always carries linear cleanup authority.
#[derive(Debug)]
#[must_use = "protected launch completion must be matched and cleanup retained"]
pub enum ProtectedLaunchCompletion<C, E> {
    Completed(Box<ProtectedLaunchReceipt>),
    CleanupRequired(ProtectedLaunchCompletionFailure<C, E>),
}

impl<C, E> ProtectedLaunchCompletion<C, E> {
    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "Windows mints internally; other platform provisioners remain gated"
        )
    )]
    pub(in crate::management::driver) fn completed(receipt: ProtectedLaunchReceipt) -> Self {
        Self::Completed(Box::new(receipt))
    }

    /// Returns a failure inseparably paired with its cleanup owner.
    pub const fn cleanup_required(error: E, cleanup: ProtectedLaunchCleanupOwner<C>) -> Self {
        Self::CleanupRequired(ProtectedLaunchCompletionFailure::new(error, cleanup))
    }
}
