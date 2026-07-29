use agent_platform::containment::{ContainmentPort, SpawnResult};

use super::super::super::facts::{LaunchRejection, authority_rejection, report_satisfies};
use super::super::super::provision::{ProtectedLaunchProvisionPort, physical_facts};
use super::super::super::state::AdmissionClosureReason;
use super::super::super::{SupervisorDriverError, SupervisorLifecycleCore};
use super::super::operation::PhysicalLaunchState;
use super::AsyncLaunchSpawnOutcome;
use crate::management::SupervisorLifecycleClock;
use crate::process_table::{ContainmentOperationError, PendingSpawnFinishError};

impl<P, V> SupervisorLifecycleCore<P, V>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    pub(in crate::management) fn finish_async_spawn(
        &mut self,
        state: &mut PhysicalLaunchState,
        spawned: SpawnResult<P::Group, ()>,
        clock: &dyn SupervisorLifecycleClock,
    ) -> Result<AsyncLaunchSpawnOutcome, SupervisorDriverError<P::Error>> {
        let pending = state
            .pending_spawn
            .take()
            .ok_or(super::super::super::state::CleanupStateError::InvalidTransition)?;
        let finished = self.ownership.finish_pending_spawn(pending, spawned);
        let finished = match finished {
            Ok(finished) => finished,
            Err(PendingSpawnFinishError::Operation(operation)) => {
                return self.finish_failed_async_spawn(state, operation, clock);
            }
            Err(invariant @ PendingSpawnFinishError::Invariant { .. }) => {
                invariant.fail_closed();
            }
        };
        debug_assert_eq!(finished.key(), &state.ownership_key());
        let observed = match self.sample_after_async_owned_effect(state, clock) {
            Ok(observed) => observed,
            Err(SupervisorDriverError::CleanupState(error)) => {
                return Ok(AsyncLaunchSpawnOutcome::Stop(Err(error)));
            }
            Err(error) => return Err(error),
        };
        let receipt = self
            .ownership
            .physical_spawn_receipt(finished.key())
            .map_err(SupervisorDriverError::Ownership)?;
        let rejection = if finished.pending_termination_exit_code().is_some()
            || !self.state.is_accepting_launches()
        {
            Some(LaunchRejection::AdmissionClosed)
        } else if let Some(rejection) = authority_rejection(&state.plan, observed) {
            Some(rejection)
        } else if !report_satisfies(
            receipt.containment_report(),
            self.policy.required_containment_level(),
            state.plan.required_limits(),
        ) {
            Some(LaunchRejection::ContainmentUnavailable)
        } else {
            None
        };
        if let Some(rejection) = rejection {
            self.close_owned_attempt(
                AdmissionClosureReason::AuthorityExpired,
                finished.key(),
                observed,
            )?;
            let emission =
                self.prepare_reserved_rejection(&state.plan, &state.intent, rejection, observed)?;
            return Ok(AsyncLaunchSpawnOutcome::Stop(Ok(emission)));
        }
        let physical = physical_facts(&receipt);
        if !physical.runner_is_distinct_from(&self.peer_authority) {
            self.close_owned_attempt(
                AdmissionClosureReason::OwnedSpawnFailure,
                finished.key(),
                observed,
            )?;
            let emission = self.prepare_reserved_rejection(
                &state.plan,
                &state.intent,
                LaunchRejection::InvalidEndpoints,
                observed,
            )?;
            return Ok(AsyncLaunchSpawnOutcome::Stop(Ok(emission)));
        }
        Ok(AsyncLaunchSpawnOutcome::Complete(physical))
    }

    fn finish_failed_async_spawn(
        &mut self,
        state: &mut PhysicalLaunchState,
        operation: ContainmentOperationError<()>,
        clock: &dyn SupervisorLifecycleClock,
    ) -> Result<AsyncLaunchSpawnOutcome, SupervisorDriverError<P::Error>> {
        let key = state.ownership_key();
        let owned = self.ownership.state(&key).is_ok();
        let observed = if owned {
            self.sample_after_async_owned_effect(state, clock)?
        } else {
            self.sample_async_gate(state, clock)?
        };
        if let ContainmentOperationError::Ownership(error) = operation {
            return Err(SupervisorDriverError::Ownership(error));
        }
        if owned {
            self.close_owned_attempt(AdmissionClosureReason::OwnedSpawnFailure, &key, observed)?;
        }
        let emission = self.prepare_reserved_rejection(
            &state.plan,
            &state.intent,
            LaunchRejection::ContainmentUnavailable,
            observed,
        )?;
        Ok(AsyncLaunchSpawnOutcome::Resolve(emission))
    }
}
