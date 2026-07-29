use std::time::Duration;

use agent_platform::containment::ContainmentPort;

use super::{
    ContainmentOperationError, Entry, Owned, OwnershipError, OwnershipKey, OwnershipRegistry,
    PhysicalState, PlatformReaper, ReapBackend, ReapedAttempt, Reaping,
};

mod cleanup;
mod commit;
mod terminated;

impl<G> OwnershipRegistry<G> {
    /// Reaps the process tree through the platform containment boundary.
    ///
    /// Admission is released only after the platform returns opaque physical
    /// reap evidence and the registry validates its group and process
    /// attribution. Platform reap failure always restores the returned group
    /// and token.
    ///
    /// # Errors
    ///
    /// Rejects stale/invalid ownership or returns the platform reap error after
    /// restoring the exact group and admission token.
    pub fn reap<P>(
        &mut self,
        port: &P,
        key: &OwnershipKey,
        timeout: Duration,
    ) -> Result<ReapedAttempt, ContainmentOperationError<P::Error>>
    where
        P: ContainmentPort<Group = G>,
    {
        self.reap_with(&PlatformReaper(port), key, timeout)
    }

    pub(super) fn reap_with<B>(
        &mut self,
        backend: &B,
        key: &OwnershipKey,
        timeout: Duration,
    ) -> Result<ReapedAttempt, ContainmentOperationError<B::Error>>
    where
        B: ReapBackend<G>,
    {
        let entry = self
            .take_matching(key)
            .map_err(ContainmentOperationError::Ownership)?;
        let reaping = match entry {
            Entry::Exited(owned) => Owned {
                metadata: owned.metadata,
                reservation: owned.reservation,
                state: Reaping {
                    physical: owned.state.physical,
                    observed: Some(owned.state.observed),
                },
            },
            Entry::Reaping(owned) if owned.state.observed.is_some() => owned,
            Entry::Reaping(owned) => {
                self.restore(Entry::Reaping(owned));
                return Err(ContainmentOperationError::Ownership(
                    OwnershipError::MissingObservedExit,
                ));
            }
            other => {
                let from = other.state();
                self.restore(other);
                return Err(ContainmentOperationError::Ownership(
                    OwnershipError::InvalidTransition {
                        from,
                        requested: PhysicalState::Reaping,
                    },
                ));
            }
        };
        if !self.admission.owns(&reaping.reservation) {
            self.restore(Entry::Reaping(reaping));
            return Err(ContainmentOperationError::Ownership(
                OwnershipError::AdmissionInvariant(
                    crate::admission::AdmissionError::StaleReservation,
                ),
            ));
        }
        let observed_at_unix_ms = reaping
            .state
            .observed
            .as_ref()
            .expect("reap transition retained observed exit")
            .observed_at_unix_ms;
        self.finish_reap(backend, reaping, timeout, Some(observed_at_unix_ms))
    }
}
