use agent_platform::containment::ContainmentPort;

use super::super::super::completion_cleanup::ManagedLaunchCleanup;
use super::super::super::fact_flow::FactIntent;
use super::super::super::facts::{LaunchRejection, authority_rejection};
use super::super::super::launch_registry::AcceptedLaunchSnapshot;
use super::super::super::provision::{
    ProtectedLaunchCleanupOwner, ProtectedLaunchProvisionPort, physical_facts,
};
use super::super::super::reporting::{LaunchAcceptance, PreparedLaunchEmission};
use super::super::super::state::AdmissionClosureReason;
use super::super::super::{SupervisorDriverError, SupervisorLifecycleCore};
use super::super::operation::PhysicalLaunchState;
use super::AsyncWorkerCompletion;
use crate::management::SupervisorLifecycleClock;
use crate::process_table::{OwnershipError, PhysicalState};

impl<P, V> SupervisorLifecycleCore<P, V>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    pub(in crate::management) fn finish_async_completion(
        &mut self,
        state: &mut PhysicalLaunchState,
        completion: AsyncWorkerCompletion,
        clock: &dyn SupervisorLifecycleClock,
    ) -> Result<PreparedLaunchEmission, SupervisorDriverError<P::Error>> {
        let key = state.ownership_key();
        let protected_receipt = match completion {
            AsyncWorkerCompletion::Completed(receipt) => Some(receipt),
            AsyncWorkerCompletion::CleanupRequired(cleanup) => {
                self.completion_cleanup.retain(
                    key.clone(),
                    ProtectedLaunchCleanupOwner::new(ManagedLaunchCleanup::Remote(cleanup)),
                );
                None
            }
        };
        let physical_state = self
            .ownership
            .mark_bootstrap_complete(&key)
            .map_err(SupervisorDriverError::Ownership)?;
        let observed = self.sample_after_async_owned_effect(state, clock)?;
        let receipt = self
            .ownership
            .physical_spawn_receipt(&key)
            .map_err(SupervisorDriverError::Ownership)?;
        let physical = physical_facts(&receipt);
        let rejection =
            if physical_state != PhysicalState::Reserved || !self.state.is_accepting_launches() {
                Some(LaunchRejection::AdmissionClosed)
            } else {
                authority_rejection(&state.plan, observed)
            };
        if let Some(rejection) = rejection {
            self.close_owned_attempt(AdmissionClosureReason::AuthorityExpired, &key, observed)?;
            return self.prepare_reserved_rejection(
                &state.plan,
                &state.intent,
                rejection,
                observed,
            );
        }
        let Some(protected_receipt) = protected_receipt.filter(|receipt| {
            receipt
                .validate(&state.plan, &self.peer_authority, &physical)
                .is_ok()
        }) else {
            self.close_owned_attempt(AdmissionClosureReason::OwnedSpawnFailure, &key, observed)?;
            return self.prepare_reserved_rejection(
                &state.plan,
                &state.intent,
                LaunchRejection::InvalidEndpoints,
                observed,
            );
        };
        let accepted = AcceptedLaunchSnapshot::capture(&state.plan, &receipt, observed)
            .ok_or(SupervisorDriverError::PhysicalReceiptMismatch)?;
        if !self
            .launch_registry
            .mark_owned(&state.intent, &state.plan, accepted)
        {
            self.close_owned_attempt(AdmissionClosureReason::OwnedSpawnFailure, &key, observed)?;
            return Err(SupervisorDriverError::FactFlowInvariant);
        }
        self.prepare_launch_accepted(
            &state.plan,
            LaunchAcceptance::fresh(
                &receipt,
                &key,
                FactIntent::Registered(state.intent.clone()),
                observed,
                protected_receipt,
            ),
        )
    }

    pub(in crate::management) fn finish_stopped_async_launch(
        &mut self,
        state: &PhysicalLaunchState,
    ) -> Result<(), SupervisorDriverError<P::Error>> {
        let key = state.ownership_key();
        let bootstrap_pending = match self.ownership.bootstrap_pending(&key) {
            Ok(pending) => pending,
            Err(OwnershipError::MissingAttempt) => false,
            Err(error) => return Err(SupervisorDriverError::Ownership(error)),
        };
        if bootstrap_pending {
            let physical_state = self
                .ownership
                .mark_bootstrap_complete(&key)
                .map_err(SupervisorDriverError::Ownership)?;
            if physical_state != PhysicalState::Cancelling {
                self.close_owned_attempt(
                    AdmissionClosureReason::OwnedSpawnFailure,
                    &key,
                    state.last_gate_unix_ms,
                )?;
            }
        }
        Ok(())
    }
}
