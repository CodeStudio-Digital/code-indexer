use std::time::Duration;

use agent_platform::containment::ContainmentPort;

use super::super::{
    ContainmentOperationError, Entry, Owned, OwnershipError, OwnershipKey, OwnershipRegistry,
    PhysicalState, PlatformReaper, ReapBackend, ReapedAttempt, Reaping,
};

impl<G> OwnershipRegistry<G> {
    /// Reaps a process tree after termination was requested but before an
    /// independent root-exit notification exists.
    ///
    /// Only successful physical reap evidence creates the observed exit and
    /// releases admission. Timeout or platform failure restores the exact
    /// resource group and reservation in `Reaping`.
    ///
    /// # Errors
    ///
    /// Rejects stale ownership, non-positive observation time, or a state that
    /// was not physically cancelling/reaping.
    pub(crate) fn reap_terminated<P>(
        &mut self,
        port: &P,
        key: &OwnershipKey,
        timeout: Duration,
        observed_at_unix_ms: i64,
    ) -> Result<ReapedAttempt, ContainmentOperationError<P::Error>>
    where
        P: ContainmentPort<Group = G>,
    {
        self.reap_terminated_with(&PlatformReaper(port), key, timeout, observed_at_unix_ms)
    }

    pub(in crate::process_table) fn reap_terminated_with<B>(
        &mut self,
        backend: &B,
        key: &OwnershipKey,
        timeout: Duration,
        observed_at_unix_ms: i64,
    ) -> Result<ReapedAttempt, ContainmentOperationError<B::Error>>
    where
        B: ReapBackend<G>,
    {
        if observed_at_unix_ms <= 0 {
            return Err(ContainmentOperationError::Ownership(
                OwnershipError::InvalidObservedAt,
            ));
        }
        let entry = self
            .take_matching(key)
            .map_err(ContainmentOperationError::Ownership)?;
        let reaping = match entry {
            Entry::Cancelling(owned) => Owned {
                metadata: owned.metadata,
                reservation: owned.reservation,
                state: Reaping {
                    physical: owned.state.0,
                    observed: None,
                },
            },
            Entry::Reaping(owned) if owned.state.observed.is_none() => owned,
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
        self.finish_reap(backend, reaping, timeout, Some(observed_at_unix_ms))
    }
}
