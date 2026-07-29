use super::super::{
    Cancelling, Entry, Exited, Owned, OwnershipError, OwnershipKey, OwnershipRegistry,
    PhysicalState, Reserved,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpawnHandoffState {
    Launching,
    BootstrapPending,
}

impl<G> OwnershipRegistry<G> {
    pub(crate) fn spawn_handoff_state(
        &self,
        key: &OwnershipKey,
    ) -> Result<Option<SpawnHandoffState>, OwnershipError> {
        self.matching(key).map(|entry| match entry {
            Entry::Launching(_) => Some(SpawnHandoffState::Launching),
            Entry::BootstrapPending(_) => Some(SpawnHandoffState::BootstrapPending),
            _ => None,
        })
    }

    pub(crate) fn bootstrap_pending(&self, key: &OwnershipKey) -> Result<bool, OwnershipError> {
        self.spawn_handoff_state(key)
            .map(|state| state == Some(SpawnHandoffState::BootstrapPending))
    }

    pub(crate) fn mark_bootstrap_complete(
        &mut self,
        key: &OwnershipKey,
    ) -> Result<PhysicalState, OwnershipError> {
        let entry = self.take_matching(key)?;
        let next = match entry {
            Entry::BootstrapPending(owned) => {
                match (owned.state.observed_exit, owned.state.termination_exit_code) {
                    (Some(observed), _) => Entry::Exited(Owned {
                        metadata: owned.metadata,
                        reservation: owned.reservation,
                        state: Exited {
                            physical: owned.state.physical,
                            observed,
                        },
                    }),
                    (None, Some(_)) => Entry::Cancelling(Owned {
                        metadata: owned.metadata,
                        reservation: owned.reservation,
                        state: Cancelling(owned.state.physical),
                    }),
                    (None, None) => Entry::Reserved(Owned {
                        metadata: owned.metadata,
                        reservation: owned.reservation,
                        state: Reserved(owned.state.physical),
                    }),
                }
            }
            Entry::Reserved(owned) => Entry::Reserved(owned),
            Entry::Running(owned) => Entry::Running(owned),
            Entry::Cancelling(owned) => Entry::Cancelling(owned),
            Entry::Exited(owned) => Entry::Exited(owned),
            Entry::Reaping(owned) => Entry::Reaping(owned),
            other => {
                let from = other.state();
                self.restore(other);
                return Err(OwnershipError::InvalidTransition {
                    from,
                    requested: PhysicalState::Reserved,
                });
            }
        };
        let state = next.state();
        self.restore(next);
        Ok(state)
    }
}
