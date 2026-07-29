use agent_platform::containment::ContainmentPort;

use super::{
    Cancelling, ContainmentOperationError, Entry, Exited, ObservedExit, Owned, OwnershipError,
    OwnershipKey, OwnershipRegistry, PhysicalState, Running,
};

mod bootstrap;
mod pending_spawn;
mod spawn;

pub use bootstrap::SpawnHandoffState;
pub use pending_spawn::{PendingSpawn, PendingSpawnFinishError, PendingSpawnReservation};
pub use spawn::execute_contained_spawn;

impl<G> OwnershipRegistry<G> {
    /// Marks the pre-activation contained runner as running.
    ///
    /// # Errors
    ///
    /// Rejects stale ownership and any transition after cancellation/exit.
    pub fn mark_running(&mut self, key: &OwnershipKey) -> Result<(), OwnershipError> {
        let entry = self.take_matching(key)?;
        match entry {
            Entry::Reserved(owned) => self.restore(Entry::Running(Owned {
                metadata: owned.metadata,
                reservation: owned.reservation,
                state: Running(owned.state.0),
            })),
            Entry::Running(owned) => self.restore(Entry::Running(owned)),
            other => {
                let from = other.state();
                self.restore(other);
                return Err(OwnershipError::InvalidTransition {
                    from,
                    requested: PhysicalState::Running,
                });
            }
        }
        Ok(())
    }

    /// Requests process-tree termination while retaining physical ownership.
    ///
    /// Repeated cancellation is idempotent. A platform failure leaves the
    /// entry in `Cancelling` with the exact group and reservation still owned.
    ///
    /// # Errors
    ///
    /// Rejects stale or invalid transitions and reports platform termination
    /// failures after restoring ownership.
    pub fn terminate<P>(
        &mut self,
        port: &P,
        key: &OwnershipKey,
        exit_code: u32,
    ) -> Result<(), ContainmentOperationError<P::Error>>
    where
        P: ContainmentPort<Group = G>,
    {
        let entry = self
            .take_matching(key)
            .map_err(ContainmentOperationError::Ownership)?;
        let cancelling = match entry {
            Entry::Launching(mut owned) => {
                owned.state.termination_exit_code = Some(exit_code);
                self.restore(Entry::Launching(owned));
                return Ok(());
            }
            Entry::BootstrapPending(mut owned) => {
                owned.state.termination_exit_code = Some(exit_code);
                let result = port.terminate_group(&owned.state.physical.group, exit_code);
                self.restore(Entry::BootstrapPending(owned));
                return result.map_err(ContainmentOperationError::Platform);
            }
            Entry::Reserved(owned) => Owned {
                metadata: owned.metadata,
                reservation: owned.reservation,
                state: Cancelling(owned.state.0),
            },
            Entry::Running(owned) => Owned {
                metadata: owned.metadata,
                reservation: owned.reservation,
                state: Cancelling(owned.state.0),
            },
            Entry::Cancelling(owned) => owned,
            Entry::Exited(owned) => {
                let result = port.terminate_group(&owned.state.physical.group, exit_code);
                self.restore(Entry::Exited(owned));
                return result.map_err(ContainmentOperationError::Platform);
            }
            Entry::Reaping(owned) => {
                let result = port.terminate_group(&owned.state.physical.group, exit_code);
                self.restore(Entry::Reaping(owned));
                return result.map_err(ContainmentOperationError::Platform);
            }
            Entry::Quarantined(quarantined) => {
                self.restore(Entry::Quarantined(quarantined));
                return Err(ContainmentOperationError::Ownership(
                    OwnershipError::InvalidTransition {
                        from: PhysicalState::Quarantined,
                        requested: PhysicalState::Cancelling,
                    },
                ));
            }
        };
        let result = port.terminate_group(&cancelling.state.0.group, exit_code);
        self.restore(Entry::Cancelling(cancelling));
        result.map_err(ContainmentOperationError::Platform)
    }

    /// Records an observed root-process exit without releasing any ownership.
    ///
    /// # Errors
    ///
    /// Rejects stale ownership and transitions from a non-physical state.
    pub fn mark_exited(
        &mut self,
        key: &OwnershipKey,
        observed: ObservedExit,
    ) -> Result<(), OwnershipError> {
        let entry = self.take_matching(key)?;
        let exited = match entry {
            Entry::BootstrapPending(mut owned) => {
                owned.state.observed_exit = Some(observed);
                self.restore(Entry::BootstrapPending(owned));
                return Ok(());
            }
            Entry::Reserved(owned) => Owned {
                metadata: owned.metadata,
                reservation: owned.reservation,
                state: Exited {
                    physical: owned.state.0,
                    observed,
                },
            },
            Entry::Running(owned) => Owned {
                metadata: owned.metadata,
                reservation: owned.reservation,
                state: Exited {
                    physical: owned.state.0,
                    observed,
                },
            },
            Entry::Cancelling(owned) => Owned {
                metadata: owned.metadata,
                reservation: owned.reservation,
                state: Exited {
                    physical: owned.state.0,
                    observed,
                },
            },
            Entry::Exited(owned) if owned.state.observed == observed => {
                self.restore(Entry::Exited(owned));
                return Ok(());
            }
            Entry::Reaping(mut owned) if owned.state.observed.is_none() => {
                owned.state.observed = Some(observed);
                self.restore(Entry::Reaping(owned));
                return Ok(());
            }
            Entry::Reaping(owned) if owned.state.observed == Some(observed) => {
                self.restore(Entry::Reaping(owned));
                return Ok(());
            }
            other => {
                let from = other.state();
                self.restore(other);
                return Err(OwnershipError::InvalidTransition {
                    from,
                    requested: PhysicalState::Exited,
                });
            }
        };
        self.restore(Entry::Exited(exited));
        Ok(())
    }
}
