use agent_platform::containment::ContainmentPort;

use super::super::fact_flow::FactIntent;
use super::super::facts::LaunchRejection;
use super::super::launch_registry::{AcceptedLaunchSnapshot, LaunchIntentKey, LaunchRegistryMatch};
use super::super::plan::LaunchPlan;
use super::super::provision::ProtectedLaunchProvisionPort;
use super::super::reporting::{LaunchAcceptance, PreparedLaunchEmission};
use super::super::{SupervisorDriverError, SupervisorLifecycleCore};
use crate::process_table::{OwnershipError, OwnershipKey, PhysicalState};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum LaunchDisposition {
    Fresh,
    Exact {
        intent_key: LaunchIntentKey,
        accepted: Box<AcceptedLaunchSnapshot>,
        live_owner: bool,
    },
    Rejected {
        intent_key: LaunchIntentKey,
        rejection: LaunchRejection,
        rejected_at_unix_ms: i64,
    },
    Conflict,
}

impl<P, V> SupervisorLifecycleCore<P, V>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    pub(super) fn classify_launch(
        &self,
        plan: &LaunchPlan,
        key: &OwnershipKey,
    ) -> LaunchDisposition {
        match (
            self.launch_registry.classify(plan),
            self.ownership.state(key),
        ) {
            (LaunchRegistryMatch::Fresh, Err(OwnershipError::MissingAttempt)) => {
                LaunchDisposition::Fresh
            }
            (
                LaunchRegistryMatch::Owned {
                    intent_key,
                    accepted,
                    physical_reaped: false,
                },
                Ok(
                    PhysicalState::Reserved
                    | PhysicalState::Running
                    | PhysicalState::Cancelling
                    | PhysicalState::Exited
                    | PhysicalState::Reaping,
                ),
            ) => LaunchDisposition::Exact {
                intent_key,
                accepted,
                live_owner: true,
            },
            (
                LaunchRegistryMatch::Owned {
                    intent_key,
                    accepted,
                    physical_reaped: true,
                },
                Err(OwnershipError::MissingAttempt),
            ) => LaunchDisposition::Exact {
                intent_key,
                accepted,
                live_owner: false,
            },
            (
                LaunchRegistryMatch::Rejected {
                    intent_key,
                    rejection,
                    rejected_at_unix_ms,
                },
                _,
            ) => LaunchDisposition::Rejected {
                intent_key,
                rejection,
                rejected_at_unix_ms,
            },
            _ => LaunchDisposition::Conflict,
        }
    }

    pub(super) fn prepare_existing_launch(
        &self,
        plan: &LaunchPlan,
        key: &OwnershipKey,
        intent: LaunchIntentKey,
        accepted: Box<AcceptedLaunchSnapshot>,
        live_owner: bool,
        observed_at_unix_ms: i64,
    ) -> Result<PreparedLaunchEmission, SupervisorDriverError<P::Error>> {
        self.prepare_launch_accepted(
            plan,
            LaunchAcceptance::replay(
                accepted,
                FactIntent::Registered(intent),
                observed_at_unix_ms,
                live_owner.then_some(key),
            ),
        )
    }
}
