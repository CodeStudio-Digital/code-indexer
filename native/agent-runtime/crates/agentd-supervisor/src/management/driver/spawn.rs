use agent_platform::containment::ContainmentPort;

use super::cleanup::LifecycleClockSampler;
use super::facts::LaunchRejection;
use super::launch_registry::LaunchIntentKey;
use super::plan::LaunchPlan;
use super::provision::{PreparedProtectedLaunch, ProtectedLaunchProvisionPort};
use super::reporting::PreparedLaunchEmission;
use super::state::{AdmissionClosureReason, CleanupStateError};
use super::{SupervisorDriverError, SupervisorLifecycleCore};
use crate::process_table::{
    ContainmentOperationError, OwnershipError, OwnershipKey, ReserveOutcome,
};

mod handoff;

impl<P, V> SupervisorLifecycleCore<P, V>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    pub(super) fn spawn_prepared_launch(
        &mut self,
        plan: &LaunchPlan,
        key: &OwnershipKey,
        intent: LaunchIntentKey,
        prepared: PreparedProtectedLaunch<V::Pending>,
        clock: &mut LifecycleClockSampler<'_>,
    ) -> Result<PreparedLaunchEmission, SupervisorDriverError<P::Error>> {
        let (child_handles, pending_handoff) = prepared.into_spawn_parts();
        let before_spawn_unix_ms = clock.last().ok_or(CleanupStateError::InvalidTransition)?;
        let outcome = self.ownership.spawn_reserved_with_handles(
            self.containment.as_ref(),
            plan.metadata(),
            plan.budget(),
            &self.trusted_runner.contained_launch(),
            child_handles,
        );
        match outcome {
            Ok(ReserveOutcome::Reserved) => {
                let spawned_at_unix_ms =
                    self.sample_after_owned_launch_effect(key, clock, before_spawn_unix_ms)?;
                self.validate_spawn_and_complete(
                    plan,
                    key,
                    intent,
                    pending_handoff,
                    spawned_at_unix_ms,
                    clock,
                )
            }
            Ok(ReserveOutcome::AlreadyOwned(_)) => {
                let observed_at_unix_ms =
                    self.sample_after_owned_launch_effect(key, clock, before_spawn_unix_ms)?;
                self.prepare_reserved_rejection(
                    plan,
                    &intent,
                    LaunchRejection::DuplicateConflict,
                    observed_at_unix_ms,
                )
            }
            Err(ContainmentOperationError::Ownership(error)) => {
                let observed_at_unix_ms = clock.sample()?;
                self.prepare_reserved_rejection(
                    plan,
                    &intent,
                    rejection_for_ownership(&error),
                    observed_at_unix_ms,
                )
            }
            Err(ContainmentOperationError::Platform(_)) => {
                let physical_owned = self.ownership.state(key).is_ok();
                let observed_at_unix_ms = if physical_owned {
                    self.sample_after_owned_launch_effect(key, clock, before_spawn_unix_ms)?
                } else {
                    clock.sample()?
                };
                if physical_owned {
                    self.close_owned_attempt(
                        AdmissionClosureReason::OwnedSpawnFailure,
                        key,
                        observed_at_unix_ms,
                    )?;
                }
                self.prepare_reserved_rejection(
                    plan,
                    &intent,
                    LaunchRejection::ContainmentUnavailable,
                    observed_at_unix_ms,
                )
            }
        }
    }
}

const fn rejection_for_ownership(error: &OwnershipError) -> LaunchRejection {
    match error {
        OwnershipError::StaleOwnership => LaunchRejection::DuplicateConflict,
        OwnershipError::Admission(_) | OwnershipError::CapacityExceeded => {
            LaunchRejection::BudgetUnavailable
        }
        _ => LaunchRejection::ContainmentUnavailable,
    }
}
