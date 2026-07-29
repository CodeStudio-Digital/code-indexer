use std::fmt::{self, Debug, Formatter};

use agent_protocol::generated::v1 as wire;
use agent_protocol::identity::AttemptIdentity;
use agent_protocol::wire_identity::identity_to_wire;

use super::LaunchIntentKey;
use crate::management::driver::facts::LaunchRejection;
use crate::management::driver::plan::LaunchPlan;
use crate::management::driver::termination::model::PhysicalCleanupCause;
use crate::management::driver::termination::plan::TerminationCommand;
use crate::process_table::{OwnershipKey, PhysicalSpawnReceipt};

#[derive(Clone, PartialEq, Eq)]
pub(super) enum LaunchOutcome {
    Pending,
    Owned(Box<AcceptedLaunchSnapshot>),
    Rejected {
        rejection: LaunchRejection,
        rejected_at_unix_ms: i64,
    },
}

#[derive(Clone, PartialEq, Eq)]
pub(in crate::management::driver) struct AcceptedLaunchSnapshot {
    accepted: wire::LaunchAccepted,
}

impl AcceptedLaunchSnapshot {
    pub(in crate::management::driver) fn capture(
        plan: &LaunchPlan,
        receipt: &PhysicalSpawnReceipt,
        accepted_at_unix_ms: i64,
    ) -> Option<Self> {
        (receipt.metadata() == &plan.metadata()).then(|| Self {
            accepted: wire::LaunchAccepted {
                identity: Some(identity_to_wire(plan.identity())),
                reservation_id: receipt.reservation_id().into(),
                reserved_budget: Some(plan.budget_wire()),
                hard_deadline_at_unix_ms: plan.hard_deadline_at_unix_ms(),
                accepted_at_unix_ms,
            },
        })
    }

    pub(in crate::management::driver) fn to_wire(
        &self,
        observed_at_unix_ms: i64,
    ) -> wire::ManagementPayload {
        let mut accepted = self.accepted.clone();
        accepted.accepted_at_unix_ms = observed_at_unix_ms;
        wire::ManagementPayload {
            body: Some(wire::management_payload::Body::LaunchAccepted(accepted)),
        }
    }

    #[cfg(test)]
    pub(super) fn for_test(plan: &LaunchPlan) -> Self {
        Self {
            accepted: wire::LaunchAccepted {
                identity: Some(identity_to_wire(plan.identity())),
                reservation_id: "reservation:test".into(),
                reserved_budget: Some(plan.budget_wire()),
                hard_deadline_at_unix_ms: plan.hard_deadline_at_unix_ms(),
                accepted_at_unix_ms: 1,
            },
        }
    }
}

impl Debug for AcceptedLaunchSnapshot {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AcceptedLaunchSnapshot")
            .field("outcome", &"[REDACTED]")
            .finish()
    }
}

pub(super) struct LaunchRecord {
    pub(super) identity: AttemptIdentity,
    pub(super) ownership_key: OwnershipKey,
    pub(super) payload_digest: [u8; 32],
    pub(super) outcome: LaunchOutcome,
    pub(super) unacked_facts: usize,
    pub(super) host_durable: bool,
    pub(super) physical_cleanup_required: bool,
    pub(super) physical_reaped: bool,
    pub(super) cancel_termination: Option<TerminationRecord>,
    pub(super) fence_termination: Option<TerminationRecord>,
    pub(super) reap_termination: Option<TerminationRecord>,
    pub(super) ordinal: u64,
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct TerminationRecord {
    idempotency_key: String,
    payload_digest: [u8; 32],
    cause: PhysicalCleanupCause,
    scheduled: bool,
}

impl TerminationRecord {
    pub(super) fn reserved(command: &TerminationCommand) -> Self {
        Self {
            idempotency_key: command.idempotency_key().to_owned(),
            payload_digest: *command.payload_digest(),
            cause: command.cause().clone(),
            scheduled: false,
        }
    }

    pub(super) fn matches(&self, command: &TerminationCommand) -> bool {
        self.idempotency_key == command.idempotency_key()
            && self.payload_digest == *command.payload_digest()
            && &self.cause == command.cause()
    }

    pub(super) fn uses_idempotency_key(&self, idempotency_key: &str) -> bool {
        self.idempotency_key == idempotency_key
    }

    pub(super) const fn is_scheduled(&self) -> bool {
        self.scheduled
    }

    pub(super) const fn mark_scheduled(&mut self) {
        self.scheduled = true;
    }
}

impl LaunchRecord {
    pub(super) fn intent_key(&self, idempotency_key: &str) -> LaunchIntentKey {
        LaunchIntentKey {
            idempotency_key: idempotency_key.to_owned(),
            ordinal: self.ordinal,
        }
    }

    pub(super) const fn eligible_for_eviction(&self) -> bool {
        if self.unacked_facts != 0
            || !self.host_durable
            || (self.physical_cleanup_required && !self.physical_reaped)
        {
            return false;
        }
        match &self.outcome {
            LaunchOutcome::Rejected { .. } | LaunchOutcome::Owned(_) => true,
            LaunchOutcome::Pending => false,
        }
    }

    pub(super) const fn is_owned(&self) -> bool {
        matches!(&self.outcome, LaunchOutcome::Owned(_))
    }
}

pub(super) fn record_matches_plan(record: &LaunchRecord, plan: &LaunchPlan) -> bool {
    record.identity == *plan.identity()
        && record.ownership_key == plan.ownership_key()
        && record.payload_digest == *plan.payload_digest()
}
