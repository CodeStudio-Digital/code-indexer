use agent_platform::containment::ContainmentPort;

use super::fact_flow::{AuthorityWindow, FactIntent, PendingFactAction, PendingFactStage};
use super::facts::{
    AttemptContainmentFact, AttemptSpawnedFact, LaunchAcceptedFact, LaunchRejectedFact,
    LaunchRejection,
};
use super::launch_registry::{AcceptedLaunchSnapshot, LaunchIntentKey};
use super::plan::LaunchPlan;
use super::provision::{ProtectedLaunchProvisionPort, ProtectedLaunchReceipt};
use super::state::AdmissionClosureReason;
use super::{SupervisorDriverError, SupervisorDriverStep, SupervisorLifecycleCore};
use crate::management::ManagementEnvelopeReceipt;
use crate::process_table::{OwnershipKey, PhysicalSpawnReceipt};
use emission::{PreparedLaunchAcceptance, PreparedLaunchOutcome};

mod commit;
mod emission;

pub(in crate::management) use emission::PreparedLaunchEmission;

enum LaunchAcceptanceMode<'a> {
    Fresh {
        receipt: &'a PhysicalSpawnReceipt,
        key: &'a OwnershipKey,
        protected_receipt: Box<ProtectedLaunchReceipt>,
    },
    Replay {
        accepted: Box<AcceptedLaunchSnapshot>,
        live_key: Option<&'a OwnershipKey>,
    },
}

pub(super) struct LaunchAcceptance<'a> {
    intent: FactIntent,
    observed_at_unix_ms: i64,
    mode: LaunchAcceptanceMode<'a>,
}

impl<'a> LaunchAcceptance<'a> {
    pub(super) const fn fresh(
        receipt: &'a PhysicalSpawnReceipt,
        key: &'a OwnershipKey,
        intent: FactIntent,
        observed_at_unix_ms: i64,
        protected_receipt: Box<ProtectedLaunchReceipt>,
    ) -> Self {
        Self {
            intent,
            observed_at_unix_ms,
            mode: LaunchAcceptanceMode::Fresh {
                receipt,
                key,
                protected_receipt,
            },
        }
    }

    pub(super) const fn replay(
        accepted: Box<AcceptedLaunchSnapshot>,
        intent: FactIntent,
        observed_at_unix_ms: i64,
        live_key: Option<&'a OwnershipKey>,
    ) -> Self {
        Self {
            intent,
            observed_at_unix_ms,
            mode: LaunchAcceptanceMode::Replay { accepted, live_key },
        }
    }
}

impl<P, V> SupervisorLifecycleCore<P, V>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    pub(super) fn prepare_launch_accepted(
        &self,
        plan: &LaunchPlan,
        acceptance: LaunchAcceptance<'_>,
    ) -> Result<PreparedLaunchEmission, SupervisorDriverError<P::Error>> {
        let LaunchAcceptance {
            intent,
            observed_at_unix_ms,
            mode,
        } = acceptance;
        let (payload, action, outcome) = match mode {
            LaunchAcceptanceMode::Fresh {
                receipt,
                key,
                protected_receipt,
            } => {
                let accepted = LaunchAcceptedFact::new(plan, receipt, observed_at_unix_ms)
                    .ok_or(SupervisorDriverError::PhysicalReceiptMismatch)?;
                let spawned = AttemptSpawnedFact::new(
                    plan,
                    receipt,
                    &self.trusted_runner,
                    observed_at_unix_ms,
                )
                .ok_or(SupervisorDriverError::PhysicalReceiptMismatch)?;
                let containment = AttemptContainmentFact::new(plan, receipt, observed_at_unix_ms)
                    .ok_or(SupervisorDriverError::PhysicalReceiptMismatch)?;
                (
                    accepted.to_wire(),
                    PendingFactAction::new(
                        intent,
                        PendingFactStage::Accepted {
                            key: key.clone(),
                            authority: AuthorityWindow::new(
                                plan.hard_deadline_at_unix_ms(),
                                plan.authority_lease_expires_at_unix_ms(),
                            ),
                            spawned: Box::new(spawned),
                            containment: Box::new(containment),
                        },
                    ),
                    PreparedLaunchOutcome::Accepted(PreparedLaunchAcceptance::Fresh {
                        failure_key: Box::new(key.clone()),
                        _protected_receipt: protected_receipt,
                    }),
                )
            }
            LaunchAcceptanceMode::Replay { accepted, live_key } => (
                accepted.to_wire(observed_at_unix_ms),
                PendingFactAction::new(intent, PendingFactStage::AcceptedReplay),
                PreparedLaunchOutcome::Accepted(PreparedLaunchAcceptance::Replay {
                    live_key: live_key.cloned().map(Box::new),
                }),
            ),
        };
        Ok(PreparedLaunchEmission {
            payload: Some(payload),
            action,
            outcome,
        })
    }

    pub(super) fn prepare_launch_rejected(
        plan: &LaunchPlan,
        intent: FactIntent,
        rejection: LaunchRejection,
        rejected_at_unix_ms: i64,
    ) -> PreparedLaunchEmission {
        PreparedLaunchEmission {
            payload: Some(LaunchRejectedFact::new(plan, rejection, rejected_at_unix_ms).to_wire()),
            action: PendingFactAction::new(intent, PendingFactStage::Rejected),
            outcome: PreparedLaunchOutcome::Rejected {
                reason_code: rejection.code(),
            },
        }
    }

    pub(super) fn prepare_reserved_rejection(
        &mut self,
        plan: &LaunchPlan,
        intent: &LaunchIntentKey,
        rejection: LaunchRejection,
        now_unix_ms: i64,
    ) -> Result<PreparedLaunchEmission, SupervisorDriverError<P::Error>> {
        let physical_cleanup_required = self.ownership.state(&plan.ownership_key()).is_ok();
        if !self.launch_registry.mark_rejected(
            intent,
            plan,
            rejection,
            now_unix_ms,
            physical_cleanup_required,
        ) {
            return Err(SupervisorDriverError::FactFlowInvariant);
        }
        Ok(Self::prepare_launch_rejected(
            plan,
            FactIntent::Registered(intent.clone()),
            rejection,
            now_unix_ms,
        ))
    }

    pub(in crate::management) fn track_prepared_launch(
        &mut self,
        receipt: &ManagementEnvelopeReceipt,
        emission: PreparedLaunchEmission,
    ) -> Result<SupervisorDriverStep, SupervisorDriverError<P::Error>> {
        if emission.payload.is_some() {
            return Err(SupervisorDriverError::FactFlowInvariant);
        }
        let outcome = emission.outcome;
        self.track_fact(receipt, emission.action)?;
        Ok(outcome.into_driver_step())
    }

    pub(super) fn close_expired_launch(
        &mut self,
        key: &OwnershipKey,
        now_unix_ms: i64,
    ) -> Result<(), SupervisorDriverError<P::Error>> {
        self.close_owned_attempt(AdmissionClosureReason::AuthorityExpired, key, now_unix_ms)
    }
}
