use std::time::Duration;

use agent_platform::containment::ContainmentPort;

use super::super::{
    ContainmentOperationError, Entry, Owned, OwnershipError, OwnershipKey, OwnershipRegistry,
    PhysicalState, PlatformReaper, ReapAfterCleanupError, ReapBackend, ReapedAttempt, Reaping,
};

impl<G> OwnershipRegistry<G> {
    /// Reaps after cleanup without a state check outside the ownership lock.
    ///
    /// A cooperative exit preserves its observed cause. A force-terminated
    /// attempt derives the observation only from attributed physical evidence.
    pub(crate) fn reap_after_cleanup<P>(
        &mut self,
        port: &P,
        key: &OwnershipKey,
        timeout: Duration,
        observed_at_unix_ms: i64,
    ) -> Result<ReapedAttempt, ContainmentOperationError<P::Error>>
    where
        P: ContainmentPort<Group = G>,
    {
        self.reap_after_cleanup_with(&PlatformReaper(port), key, timeout, observed_at_unix_ms)
    }

    pub(crate) fn reap_after_cleanup_gated<P, F, V>(
        &mut self,
        port: &P,
        key: &OwnershipKey,
        timeout: Duration,
        post_reap_gate: F,
    ) -> Result<ReapedAttempt, ReapAfterCleanupError<P::Error, V>>
    where
        P: ContainmentPort<Group = G>,
        F: FnOnce() -> Result<i64, V>,
    {
        self.reap_after_cleanup_with_gate(&PlatformReaper(port), key, timeout, post_reap_gate)
    }

    pub(in crate::process_table) fn reap_after_cleanup_with<B>(
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
        let reaping = self
            .take_cleanup_reaping(key)
            .map_err(ContainmentOperationError::Ownership)?;
        self.finish_reap(backend, reaping, timeout, Some(observed_at_unix_ms))
    }

    pub(in crate::process_table) fn reap_after_cleanup_with_gate<B, F, V>(
        &mut self,
        backend: &B,
        key: &OwnershipKey,
        timeout: Duration,
        post_reap_gate: F,
    ) -> Result<ReapedAttempt, ReapAfterCleanupError<B::Error, V>>
    where
        B: ReapBackend<G>,
        F: FnOnce() -> Result<i64, V>,
    {
        let reaping = self.take_cleanup_reaping(key).map_err(|error| {
            ReapAfterCleanupError::Operation(ContainmentOperationError::Ownership(error))
        })?;
        self.finish_reap_gated(backend, reaping, timeout, post_reap_gate)
    }

    fn take_cleanup_reaping(
        &mut self,
        key: &OwnershipKey,
    ) -> Result<Owned<Reaping<G>>, OwnershipError> {
        let entry = self.take_matching(key)?;
        let reaping = match entry {
            Entry::Cancelling(owned) => Owned {
                metadata: owned.metadata,
                reservation: owned.reservation,
                state: Reaping {
                    physical: owned.state.0,
                    observed: None,
                },
            },
            Entry::Exited(owned) => Owned {
                metadata: owned.metadata,
                reservation: owned.reservation,
                state: Reaping {
                    physical: owned.state.physical,
                    observed: Some(owned.state.observed),
                },
            },
            Entry::Reaping(owned) => owned,
            other => {
                let from = other.state();
                self.restore(other);
                return Err(OwnershipError::InvalidTransition {
                    from,
                    requested: PhysicalState::Reaping,
                });
            }
        };
        if !self.admission.owns(&reaping.reservation) {
            self.restore(Entry::Reaping(reaping));
            return Err(OwnershipError::AdmissionInvariant(
                crate::admission::AdmissionError::StaleReservation,
            ));
        }
        Ok(reaping)
    }
}
