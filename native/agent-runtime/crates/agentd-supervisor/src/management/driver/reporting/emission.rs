use agent_protocol::generated::v1 as wire;

use super::super::SupervisorDriverStep;
use super::super::fact_flow::PendingFactAction;
use super::super::provision::ProtectedLaunchReceipt;
use crate::process_table::OwnershipKey;

#[derive(Debug)]
pub(super) enum PreparedLaunchAcceptance {
    Fresh {
        failure_key: Box<OwnershipKey>,
        _protected_receipt: Box<ProtectedLaunchReceipt>,
    },
    Replay {
        live_key: Option<Box<OwnershipKey>>,
    },
}

#[derive(Debug)]
pub(super) enum PreparedLaunchOutcome {
    Accepted(PreparedLaunchAcceptance),
    Rejected { reason_code: &'static str },
}

impl PreparedLaunchOutcome {
    fn write_failure_key(&self) -> Option<&OwnershipKey> {
        match self {
            Self::Accepted(PreparedLaunchAcceptance::Fresh { failure_key, .. }) => {
                Some(failure_key.as_ref())
            }
            Self::Accepted(PreparedLaunchAcceptance::Replay { live_key }) => live_key.as_deref(),
            Self::Rejected { .. } => None,
        }
    }

    pub(super) fn into_driver_step(self) -> SupervisorDriverStep {
        match self {
            Self::Accepted(acceptance) => SupervisorDriverStep::LaunchAccepted {
                reused_existing: matches!(acceptance, PreparedLaunchAcceptance::Replay { .. }),
            },
            Self::Rejected { reason_code } => SupervisorDriverStep::LaunchRejected { reason_code },
        }
    }
}

/// Opaque transport-neutral launch response and its post-write state action.
#[derive(Debug)]
pub(in crate::management) struct PreparedLaunchEmission {
    pub(super) payload: Option<wire::ManagementPayload>,
    pub(super) action: PendingFactAction,
    pub(super) outcome: PreparedLaunchOutcome,
}

impl PreparedLaunchEmission {
    pub(in crate::management) const fn take_payload(&mut self) -> wire::ManagementPayload {
        self.payload
            .take()
            .expect("launch payload is consumed once")
    }

    pub(in crate::management) fn write_failure_key(&self) -> Option<&OwnershipKey> {
        self.outcome.write_failure_key()
    }
}
