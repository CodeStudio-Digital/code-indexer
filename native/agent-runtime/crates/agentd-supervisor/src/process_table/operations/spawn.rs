use agent_platform::budget::ResourceBudget;
use agent_platform::containment::{
    ChildHandleAllowlist, ContainedLaunch, ContainmentPort, ResourceGroupId, SpawnResult,
};

use super::super::{ContainmentOperationError, OwnershipRegistry, PhysicalState, ReserveOutcome};
use super::{PendingSpawnFinishError, PendingSpawnReservation};

pub fn execute_contained_spawn<P>(
    port: &P,
    resource_group_id: ResourceGroupId,
    budget: &ResourceBudget,
    launch: &ContainedLaunch,
    child_handles: ChildHandleAllowlist,
) -> SpawnResult<P::Group, P::Error>
where
    P: ContainmentPort,
{
    port.spawn_runner_contained_with_handles(resource_group_id, budget, launch, child_handles)
}

impl<G> OwnershipRegistry<G> {
    /// Reserves resources and spawns with an explicitly empty child-handle set.
    ///
    /// # Errors
    ///
    /// Returns the same errors as [`Self::spawn_reserved_with_handles`].
    pub fn spawn_reserved<P>(
        &mut self,
        port: &P,
        metadata: super::super::AttemptRuntimeMetadata,
        budget: &ResourceBudget,
        launch: &ContainedLaunch,
    ) -> Result<ReserveOutcome, ContainmentOperationError<P::Error>>
    where
        P: ContainmentPort<Group = G>,
    {
        self.spawn_reserved_with_handles(
            port,
            metadata,
            budget,
            launch,
            ChildHandleAllowlist::new(),
        )
    }

    /// Reserves aggregate resources, then consumes the exact child-handle
    /// allowlist while spawning a contained pre-activation runner.
    ///
    /// Exact retries are idempotent. Reuse with changed identity or runtime is
    /// rejected as stale ownership.
    ///
    /// # Errors
    ///
    /// Rejects stale reuse, exhausted capacity, invalid budgets, aggregate
    /// admission exhaustion, and platform spawn failure. A clean spawn failure
    /// releases admission. A failure carrying physical ownership is retained
    /// as `Cancelling` under the supplied attempt identity.
    pub fn spawn_reserved_with_handles<P>(
        &mut self,
        port: &P,
        metadata: super::super::AttemptRuntimeMetadata,
        budget: &ResourceBudget,
        launch: &ContainedLaunch,
        child_handles: ChildHandleAllowlist,
    ) -> Result<ReserveOutcome, ContainmentOperationError<P::Error>>
    where
        P: ContainmentPort<Group = G>,
    {
        let resource_group_id = metadata.resource_group_id.clone();
        let pending = match self
            .reserve_pending_spawn(metadata, budget)
            .map_err(ContainmentOperationError::Ownership)?
        {
            PendingSpawnReservation::Reserved(pending) => *pending,
            PendingSpawnReservation::AlreadyOwned(state) => {
                return Ok(ReserveOutcome::AlreadyOwned(state));
            }
        };
        let result =
            execute_contained_spawn(port, resource_group_id, budget, launch, child_handles);
        let finished = match self.finish_pending_spawn(pending, result) {
            Ok(finished) => finished,
            Err(PendingSpawnFinishError::Operation(error)) => return Err(error),
            Err(error @ PendingSpawnFinishError::Invariant { .. }) => error.fail_closed(),
        };
        if let Some(exit_code) = finished.pending_termination_exit_code() {
            self.terminate(port, finished.key(), exit_code)?;
        }
        let completed = self
            .mark_bootstrap_complete(finished.key())
            .map_err(ContainmentOperationError::Ownership)?;
        Ok(if completed == PhysicalState::Reserved {
            ReserveOutcome::Reserved
        } else {
            ReserveOutcome::AlreadyOwned(completed)
        })
    }
}
