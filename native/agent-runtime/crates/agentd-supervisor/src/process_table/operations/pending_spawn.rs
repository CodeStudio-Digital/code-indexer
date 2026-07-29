use agent_platform::budget::ResourceBudget;
use agent_platform::containment::{SpawnFailure, SpawnResult};

use super::super::{
    BootstrapPending, Cancelling, ContainmentOperationError, Entry, Launching, Owned,
    OwnershipError, OwnershipKey, OwnershipRegistry, Physical, PhysicalState, Quarantined,
};

/// Non-cloneable authority to finish one reservation already recorded as
/// `Launching`.
#[derive(Debug)]
pub struct PendingSpawn {
    key: OwnershipKey,
    reservation_id: String,
}

impl PendingSpawn {
    #[must_use]
    pub(crate) const fn key(&self) -> &OwnershipKey {
        &self.key
    }
}

#[derive(Debug)]
pub enum PendingSpawnReservation {
    Reserved(Box<PendingSpawn>),
    AlreadyOwned(PhysicalState),
}

#[derive(Debug)]
pub struct PendingSpawnFinish {
    key: OwnershipKey,
    pending_termination_exit_code: Option<u32>,
}

impl PendingSpawnFinish {
    #[must_use]
    pub(crate) const fn key(&self) -> &OwnershipKey {
        &self.key
    }

    #[must_use]
    pub(crate) const fn pending_termination_exit_code(&self) -> Option<u32> {
        self.pending_termination_exit_code
    }
}

/// An invariant failure returns the still-owned spawn result to its caller.
/// It must be retained by a typed hard-restart state or terminate the process;
/// silently mapping it to a platform error would drop a resource group.
#[derive(Debug)]
pub enum PendingSpawnFinishError<G, E> {
    Operation(ContainmentOperationError<E>),
    Invariant {
        error: OwnershipError,
        pending: Box<PendingSpawn>,
        result: SpawnResult<G, E>,
    },
}

impl<G, E> PendingSpawnFinishError<G, E> {
    pub(crate) fn fail_closed(self) -> ! {
        std::mem::forget(self);
        std::process::abort()
    }
}

impl<G> OwnershipRegistry<G> {
    pub(crate) fn reserve_pending_spawn(
        &mut self,
        metadata: super::super::AttemptRuntimeMetadata,
        budget: &ResourceBudget,
    ) -> Result<PendingSpawnReservation, OwnershipError> {
        let attempt_id = metadata.identity.attempt_id.clone();
        if let Some(current) = self.entries.get(&attempt_id) {
            return if current.metadata() == &metadata {
                Ok(PendingSpawnReservation::AlreadyOwned(current.state()))
            } else {
                Err(OwnershipError::StaleOwnership)
            };
        }
        if self.entries.len() >= self.capacity {
            return Err(OwnershipError::CapacityExceeded);
        }

        let key = OwnershipKey::from_metadata(&metadata);
        let reservation = self
            .admission
            .reserve(&metadata.identity, budget)
            .map_err(OwnershipError::Admission)?;
        let reservation_id = reservation.opaque_id();
        let replaced = self.entries.insert(
            attempt_id,
            Entry::Launching(Owned {
                metadata,
                reservation,
                state: Launching {
                    termination_exit_code: None,
                },
            }),
        );
        debug_assert!(replaced.is_none(), "ownership slot unexpectedly occupied");
        Ok(PendingSpawnReservation::Reserved(Box::new(PendingSpawn {
            key,
            reservation_id,
        })))
    }

    pub(crate) fn finish_pending_spawn<E>(
        &mut self,
        pending: PendingSpawn,
        result: SpawnResult<G, E>,
    ) -> Result<PendingSpawnFinish, PendingSpawnFinishError<G, E>> {
        let entry = match self.take_matching(pending.key()) {
            Ok(entry) => entry,
            Err(error) => {
                return Err(PendingSpawnFinishError::Invariant {
                    error,
                    pending: Box::new(pending),
                    result,
                });
            }
        };
        let owned = match entry {
            Entry::Launching(owned) if owned.reservation.opaque_id() == pending.reservation_id => {
                owned
            }
            other => {
                let error = if matches!(other, Entry::Launching(_)) {
                    OwnershipError::StaleOwnership
                } else {
                    OwnershipError::InvalidTransition {
                        from: other.state(),
                        requested: PhysicalState::Reserved,
                    }
                };
                self.restore(other);
                return Err(PendingSpawnFinishError::Invariant {
                    error,
                    pending: Box::new(pending),
                    result,
                });
            }
        };

        match result {
            Ok(spawned) => {
                let pending_termination_exit_code = owned.state.termination_exit_code;
                self.restore(Entry::BootstrapPending(Owned {
                    metadata: owned.metadata,
                    reservation: owned.reservation,
                    state: BootstrapPending {
                        physical: Physical {
                            group: spawned.group,
                            process_id: spawned.process_id,
                            report: spawned.report,
                        },
                        termination_exit_code: pending_termination_exit_code,
                        observed_exit: None,
                    },
                }));
                Ok(PendingSpawnFinish {
                    key: pending.key,
                    pending_termination_exit_code,
                })
            }
            Err(SpawnFailure::Owned { spawned, error }) => {
                let spawned = *spawned;
                self.restore(Entry::Cancelling(Owned {
                    metadata: owned.metadata,
                    reservation: owned.reservation,
                    state: Cancelling(Physical {
                        group: spawned.group,
                        process_id: spawned.process_id,
                        report: spawned.report,
                    }),
                }));
                Err(PendingSpawnFinishError::Operation(
                    ContainmentOperationError::Platform(error),
                ))
            }
            Err(SpawnFailure::Clean(error)) => {
                if !self.admission.owns(&owned.reservation) {
                    self.restore(Entry::Launching(owned));
                    return Err(PendingSpawnFinishError::Operation(
                        ContainmentOperationError::Ownership(OwnershipError::AdmissionInvariant(
                            crate::admission::AdmissionError::StaleReservation,
                        )),
                    ));
                }
                let metadata = owned.metadata;
                if let Err(release_error) = self.admission.release(owned.reservation) {
                    self.restore(Entry::Quarantined(Quarantined { metadata }));
                    return Err(PendingSpawnFinishError::Operation(
                        ContainmentOperationError::Ownership(OwnershipError::AdmissionInvariant(
                            release_error,
                        )),
                    ));
                }
                Err(PendingSpawnFinishError::Operation(
                    ContainmentOperationError::Platform(error),
                ))
            }
        }
    }
}
