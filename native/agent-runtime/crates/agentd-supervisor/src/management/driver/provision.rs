mod completion;
#[allow(
    dead_code,
    reason = "wired into the production Windows provisioner in this implementation stage"
)]
mod deadline;
mod facts;
mod peer;
mod receipt;
mod request;
mod scrub;
mod seal;
mod staged;
#[cfg(windows)]
mod windows;

#[cfg(any(test, windows))]
pub(in crate::management::driver) use facts::ProtectedLaunchHandoffFacts;
pub use peer::{ProtectedLaunchPeerAuthority, ProtectedLaunchPeerAuthorityError};
pub use receipt::ProtectedLaunchReceipt;
pub(super) use request::ProtectedEndpointSeal;
pub use request::ProtectedLaunchRequest;
pub use staged::{PendingProtectedLaunch, PreparedProtectedLaunch, ProtectedLaunchPhysicalFacts};
#[cfg(windows)]
pub use windows::{
    WindowsProtectedLaunchCancellation, WindowsProtectedLaunchCleanup, WindowsProtectedLaunchError,
    WindowsProtectedLaunchProvisioner,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtectedLaunchProvisionError {
    Unavailable,
    ReceiptMismatch,
}

/// Two-phase protected launch boundary.
///
/// `prepare` owns child handles before spawn. `complete_after_spawn` cannot be
/// called without the pending owner and supervisor-minted physical facts.
pub trait ProtectedLaunchProvisionPort {
    type Pending;
    type Cleanup: ProtectedLaunchCleanupPort<Error = Self::Error>;
    type Error;

    /// Prepares the single-use bootstrap owner and exact inherited handles.
    ///
    /// # Errors
    ///
    /// Returns a provider-specific error before any process spawn.
    fn prepare(
        &self,
        request: &ProtectedLaunchRequest<'_>,
    ) -> Result<PreparedProtectedLaunch<Self::Pending>, Self::Error>;

    /// Completes the handoff only after contained spawn and report validation.
    ///
    /// Failure is inseparable from the linear owner needed to clean up every
    /// resource created while completing the handoff.
    fn complete_after_spawn(
        &self,
        pending: PendingProtectedLaunch<Self::Pending>,
        physical: &ProtectedLaunchPhysicalFacts,
    ) -> ProtectedLaunchCompletion<Self::Cleanup, Self::Error>;
}

#[derive(Debug, Default)]
pub struct FailClosedProtectedLaunchProvisioner;

#[derive(Debug, Default)]
pub struct FailClosedProtectedLaunchCleanup;

impl ProtectedLaunchCleanupPort for FailClosedProtectedLaunchCleanup {
    type Error = ProtectedLaunchProvisionError;

    fn try_cleanup(&mut self) -> Result<ProtectedLaunchCleanupProof, Self::Error> {
        Err(ProtectedLaunchProvisionError::Unavailable)
    }
}

impl ProtectedLaunchProvisionPort for FailClosedProtectedLaunchProvisioner {
    type Pending = ();
    type Cleanup = FailClosedProtectedLaunchCleanup;
    type Error = ProtectedLaunchProvisionError;

    fn prepare(
        &self,
        _request: &ProtectedLaunchRequest<'_>,
    ) -> Result<PreparedProtectedLaunch<Self::Pending>, Self::Error> {
        Err(ProtectedLaunchProvisionError::Unavailable)
    }

    fn complete_after_spawn(
        &self,
        _pending: PendingProtectedLaunch<Self::Pending>,
        _physical: &ProtectedLaunchPhysicalFacts,
    ) -> ProtectedLaunchCompletion<Self::Cleanup, Self::Error> {
        ProtectedLaunchCompletion::cleanup_required(
            ProtectedLaunchProvisionError::Unavailable,
            ProtectedLaunchCleanupOwner::new(FailClosedProtectedLaunchCleanup),
        )
    }
}

pub(super) fn physical_facts(
    receipt: &crate::process_table::PhysicalSpawnReceipt,
) -> ProtectedLaunchPhysicalFacts {
    ProtectedLaunchPhysicalFacts::from_spawn_receipt(receipt)
}
pub use completion::{
    ProtectedLaunchCleanupOwner, ProtectedLaunchCleanupPort, ProtectedLaunchCleanupProof,
    ProtectedLaunchCompletion, ProtectedLaunchCompletionFailure,
};
