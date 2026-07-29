use agent_platform::containment::ContainmentPort;

use super::super::super::facts::{LaunchRejection, authority_rejection};
use super::super::super::provision::ProtectedLaunchProvisionPort;
use super::super::super::reporting::PreparedLaunchEmission;
use super::super::super::{SupervisorDriverError, SupervisorLifecycleCore};
use super::super::operation::PhysicalLaunchState;
use super::AsyncLaunchPrepareOutcome;
use crate::management::SupervisorLifecycleClock;
use crate::process_table::PendingSpawnReservation;

impl<P, V> SupervisorLifecycleCore<P, V>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    pub(in crate::management) fn reject_unstarted_async_launch(
        &mut self,
        state: &mut PhysicalLaunchState,
        clock: &dyn SupervisorLifecycleClock,
    ) -> Result<PreparedLaunchEmission, SupervisorDriverError<P::Error>> {
        let observed = self.sample_async_gate(state, clock)?;
        self.prepare_reserved_rejection(
            &state.plan,
            &state.intent,
            LaunchRejection::ContainmentUnavailable,
            observed,
        )
    }

    pub(in crate::management) fn finish_async_prepare(
        &mut self,
        state: &mut PhysicalLaunchState,
        prepared: bool,
        clock: &dyn SupervisorLifecycleClock,
    ) -> Result<AsyncLaunchPrepareOutcome, SupervisorDriverError<P::Error>> {
        let observed = match self.sample_async_gate(state, clock) {
            Ok(observed) => observed,
            Err(SupervisorDriverError::CleanupState(error)) => {
                return Ok(AsyncLaunchPrepareOutcome::Stop(Err(error)));
            }
            Err(error) => return Err(error),
        };
        let rejection = if !prepared {
            Some(LaunchRejection::InvalidEndpoints)
        } else if !self.state.is_accepting_launches() {
            Some(LaunchRejection::AdmissionClosed)
        } else {
            authority_rejection(&state.plan, observed)
        };
        if let Some(rejection) = rejection {
            let emission =
                self.prepare_reserved_rejection(&state.plan, &state.intent, rejection, observed)?;
            return Ok(if prepared {
                AsyncLaunchPrepareOutcome::Stop(Ok(emission))
            } else {
                AsyncLaunchPrepareOutcome::Resolve(emission)
            });
        }
        let pending = match self
            .ownership
            .reserve_pending_spawn(state.plan.metadata(), state.plan.budget())
            .map_err(SupervisorDriverError::Ownership)?
        {
            PendingSpawnReservation::Reserved(pending) => *pending,
            PendingSpawnReservation::AlreadyOwned(_) => {
                let emission = self.prepare_reserved_rejection(
                    &state.plan,
                    &state.intent,
                    LaunchRejection::DuplicateConflict,
                    observed,
                )?;
                return Ok(AsyncLaunchPrepareOutcome::Stop(Ok(emission)));
            }
        };
        state.pending_spawn = Some(pending);
        self.state
            .install_authority_watchdog(
                observed,
                state
                    .plan
                    .hard_deadline_at_unix_ms()
                    .min(state.plan.authority_lease_expires_at_unix_ms()),
                state.ownership_key(),
            )
            .map_err(SupervisorDriverError::CleanupState)?;
        Ok(AsyncLaunchPrepareOutcome::Spawn)
    }
}
