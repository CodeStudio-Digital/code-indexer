use agent_platform::containment::ContainmentPort;

use super::super::cleanup::LifecycleClockSampler;
use super::super::completion_cleanup::ManagedLaunchCleanup;
use super::super::fact_flow::FactIntent;
use super::super::facts::{LaunchRejection, authority_rejection, report_satisfies};
use super::super::launch_registry::{AcceptedLaunchSnapshot, LaunchIntentKey};
use super::super::plan::LaunchPlan;
use super::super::provision::{
    PendingProtectedLaunch, ProtectedLaunchCompletion, ProtectedLaunchProvisionPort, physical_facts,
};
use super::super::reporting::{LaunchAcceptance, PreparedLaunchEmission};
use super::super::state::{AdmissionClosureReason, CleanupStateError};
use super::super::{SupervisorDriverError, SupervisorLifecycleCore};
use crate::process_table::{OwnershipKey, PhysicalSpawnReceipt};

impl<P, V> SupervisorLifecycleCore<P, V>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    pub(super) fn validate_spawn_and_complete(
        &mut self,
        plan: &LaunchPlan,
        key: &OwnershipKey,
        intent: LaunchIntentKey,
        pending_handoff: PendingProtectedLaunch<V::Pending>,
        spawned_at_unix_ms: i64,
        clock: &mut LifecycleClockSampler<'_>,
    ) -> Result<PreparedLaunchEmission, SupervisorDriverError<P::Error>> {
        if let Some(rejection) = authority_rejection(plan, spawned_at_unix_ms) {
            self.close_expired_launch(key, spawned_at_unix_ms)?;
            return self.prepare_reserved_rejection(plan, &intent, rejection, spawned_at_unix_ms);
        }
        let receipt = self
            .ownership
            .physical_spawn_receipt(key)
            .map_err(SupervisorDriverError::Ownership)?;
        if !report_satisfies(
            receipt.containment_report(),
            self.policy.required_containment_level(),
            plan.required_limits(),
        ) {
            self.close_owned_attempt(
                AdmissionClosureReason::ContainmentMismatch,
                key,
                spawned_at_unix_ms,
            )?;
            return self.prepare_reserved_rejection(
                plan,
                &intent,
                LaunchRejection::ContainmentUnavailable,
                spawned_at_unix_ms,
            );
        }
        self.complete_protected_handoff(plan, key, intent, pending_handoff, &receipt, clock)
    }

    fn complete_protected_handoff(
        &mut self,
        plan: &LaunchPlan,
        key: &OwnershipKey,
        intent: LaunchIntentKey,
        pending_handoff: PendingProtectedLaunch<V::Pending>,
        receipt: &PhysicalSpawnReceipt,
        clock: &mut LifecycleClockSampler<'_>,
    ) -> Result<PreparedLaunchEmission, SupervisorDriverError<P::Error>> {
        let physical = physical_facts(receipt);
        if !physical.runner_is_distinct_from(&self.peer_authority) {
            let fallback = clock.last().ok_or(CleanupStateError::InvalidTransition)?;
            let rejected_at_unix_ms =
                self.sample_after_owned_launch_effect(key, clock, fallback)?;
            self.close_owned_attempt(
                AdmissionClosureReason::OwnedSpawnFailure,
                key,
                rejected_at_unix_ms,
            )?;
            return self.prepare_reserved_rejection(
                plan,
                &intent,
                LaunchRejection::InvalidEndpoints,
                rejected_at_unix_ms,
            );
        }
        let completion = self
            .provisioner
            .complete_after_spawn(pending_handoff, &physical);
        let provisioned = match completion {
            ProtectedLaunchCompletion::Completed(provisioned) => Some(provisioned),
            ProtectedLaunchCompletion::CleanupRequired(failure) => {
                let (error, cleanup) = failure.into_parts();
                self.completion_cleanup
                    .retain(key.clone(), cleanup.map(ManagedLaunchCleanup::Local));
                drop(error);
                None
            }
        };
        let fallback = clock.last().ok_or(CleanupStateError::InvalidTransition)?;
        let completed_at_unix_ms = self.sample_after_owned_launch_effect(key, clock, fallback)?;
        if let Some(rejection) = authority_rejection(plan, completed_at_unix_ms) {
            self.close_expired_launch(key, completed_at_unix_ms)?;
            return self.prepare_reserved_rejection(plan, &intent, rejection, completed_at_unix_ms);
        }
        let provisioned = match provisioned {
            Some(provisioned)
                if provisioned
                    .validate(plan, &self.peer_authority, &physical)
                    .is_ok() =>
            {
                provisioned
            }
            Some(_) | None => {
                self.close_owned_attempt(
                    AdmissionClosureReason::OwnedSpawnFailure,
                    key,
                    completed_at_unix_ms,
                )?;
                return self.prepare_reserved_rejection(
                    plan,
                    &intent,
                    LaunchRejection::InvalidEndpoints,
                    completed_at_unix_ms,
                );
            }
        };
        if !self.arm_authority_watchdog(plan, key, completed_at_unix_ms)? {
            return self.prepare_reserved_rejection(
                plan,
                &intent,
                LaunchRejection::InvalidDeadline,
                completed_at_unix_ms,
            );
        }
        let accepted = AcceptedLaunchSnapshot::capture(plan, receipt, completed_at_unix_ms)
            .ok_or(SupervisorDriverError::PhysicalReceiptMismatch)?;
        if !self.launch_registry.mark_owned(&intent, plan, accepted) {
            self.close_owned_attempt(
                AdmissionClosureReason::OwnedSpawnFailure,
                key,
                completed_at_unix_ms,
            )?;
            return Err(SupervisorDriverError::FactFlowInvariant);
        }
        self.prepare_launch_accepted(
            plan,
            LaunchAcceptance::fresh(
                receipt,
                key,
                FactIntent::Registered(intent),
                completed_at_unix_ms,
                provisioned,
            ),
        )
    }

    pub(in crate::management::driver) fn sample_after_owned_launch_effect(
        &mut self,
        key: &OwnershipKey,
        clock: &mut LifecycleClockSampler<'_>,
        fallback_unix_ms: i64,
    ) -> Result<i64, SupervisorDriverError<P::Error>> {
        match clock.sample() {
            Ok(observed_at_unix_ms) => Ok(observed_at_unix_ms),
            Err(clock_error) => {
                self.close_owned_attempt(
                    AdmissionClosureReason::OwnedSpawnFailure,
                    key,
                    fallback_unix_ms,
                )?;
                Err(clock_error.into())
            }
        }
    }

    fn arm_authority_watchdog(
        &mut self,
        plan: &LaunchPlan,
        key: &OwnershipKey,
        now_unix_ms: i64,
    ) -> Result<bool, SupervisorDriverError<P::Error>> {
        let deadline = plan
            .hard_deadline_at_unix_ms()
            .min(plan.authority_lease_expires_at_unix_ms());
        if self
            .state
            .install_authority_watchdog(now_unix_ms, deadline, key.clone())
            .is_ok()
        {
            return Ok(true);
        }
        self.close_owned_attempt(AdmissionClosureReason::AuthorityExpired, key, now_unix_ms)?;
        Ok(false)
    }
}
