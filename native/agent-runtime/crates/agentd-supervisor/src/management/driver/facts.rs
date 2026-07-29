use agent_protocol::generated::v1 as wire;
use agent_protocol::wire_identity::identity_to_wire;

use super::config::TrustedRunnerConfig;
use super::plan::LaunchPlan;
use crate::process_table::PhysicalSpawnReceipt;

mod containment;

pub(in crate::management::driver) use containment::containment_to_wire;
pub(super) use containment::report_satisfies;
use containment::runtime_provenance;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LaunchRejection {
    AdmissionClosed,
    BudgetUnavailable,
    StaleAuthority,
    InvalidDeadline,
    ProvenanceDenied,
    ContainmentUnavailable,
    InvalidEndpoints,
    DuplicateConflict,
}

impl LaunchRejection {
    const fn wire_reason(self) -> wire::LaunchRejectionReason {
        match self {
            Self::AdmissionClosed => wire::LaunchRejectionReason::AdmissionClosed,
            Self::BudgetUnavailable => wire::LaunchRejectionReason::BudgetUnavailable,
            Self::StaleAuthority => wire::LaunchRejectionReason::StaleAuthority,
            Self::InvalidDeadline => wire::LaunchRejectionReason::InvalidDeadline,
            Self::ProvenanceDenied => wire::LaunchRejectionReason::ProvenanceDenied,
            Self::ContainmentUnavailable => wire::LaunchRejectionReason::ContainmentUnavailable,
            Self::InvalidEndpoints => wire::LaunchRejectionReason::InvalidEndpoints,
            Self::DuplicateConflict => wire::LaunchRejectionReason::DuplicateConflict,
        }
    }

    pub(super) const fn code(self) -> &'static str {
        match self {
            Self::AdmissionClosed => "SUPERVISOR_ADMISSION_CLOSED",
            Self::BudgetUnavailable => "SUPERVISOR_BUDGET_UNAVAILABLE",
            Self::StaleAuthority => "SUPERVISOR_STALE_AUTHORITY",
            Self::InvalidDeadline => "SUPERVISOR_INVALID_DEADLINE",
            Self::ProvenanceDenied => "SUPERVISOR_PROVENANCE_DENIED",
            Self::ContainmentUnavailable => "SUPERVISOR_CONTAINMENT_UNAVAILABLE",
            Self::InvalidEndpoints => "SUPERVISOR_PROTECTED_HANDOFF_UNAVAILABLE",
            Self::DuplicateConflict => "SUPERVISOR_DUPLICATE_CONFLICT",
        }
    }
}

#[derive(Debug)]
pub(in crate::management) struct LaunchRejectedFact {
    identity: agent_protocol::identity::AttemptIdentity,
    rejection: LaunchRejection,
    rejected_at_unix_ms: i64,
}

impl LaunchRejectedFact {
    pub(super) fn new(
        plan: &LaunchPlan,
        rejection: LaunchRejection,
        rejected_at_unix_ms: i64,
    ) -> Self {
        Self {
            identity: plan.identity().clone(),
            rejection,
            rejected_at_unix_ms,
        }
    }

    pub(in crate::management) fn to_wire(&self) -> wire::ManagementPayload {
        wire::ManagementPayload {
            body: Some(wire::management_payload::Body::LaunchRejected(
                wire::LaunchRejected {
                    identity: Some(identity_to_wire(&self.identity)),
                    reason: self.rejection.wire_reason() as i32,
                    reason_code: self.rejection.code().into(),
                    redacted_detail: None,
                    rejected_at_unix_ms: self.rejected_at_unix_ms,
                },
            )),
        }
    }
}

#[derive(Debug)]
pub(in crate::management) struct LaunchAcceptedFact {
    plan: LaunchPlan,
    receipt: PhysicalSpawnReceipt,
    accepted_at_unix_ms: i64,
}

impl LaunchAcceptedFact {
    pub(super) fn new(
        plan: &LaunchPlan,
        receipt: &PhysicalSpawnReceipt,
        accepted_at_unix_ms: i64,
    ) -> Option<Self> {
        (receipt.metadata() == &plan.metadata()).then(|| Self {
            plan: plan.clone(),
            receipt: receipt.clone(),
            accepted_at_unix_ms,
        })
    }

    pub(in crate::management) fn to_wire(&self) -> wire::ManagementPayload {
        wire::ManagementPayload {
            body: Some(wire::management_payload::Body::LaunchAccepted(
                wire::LaunchAccepted {
                    identity: Some(identity_to_wire(self.plan.identity())),
                    reservation_id: self.receipt.reservation_id().into(),
                    reserved_budget: Some(self.plan.budget_wire()),
                    hard_deadline_at_unix_ms: self.plan.hard_deadline_at_unix_ms(),
                    accepted_at_unix_ms: self.accepted_at_unix_ms,
                },
            )),
        }
    }
}

#[derive(Debug)]
pub(in crate::management) struct AttemptSpawnedFact {
    payload: wire::AttemptProcessSpawned,
}

impl AttemptSpawnedFact {
    pub(super) fn new(
        plan: &LaunchPlan,
        receipt: &PhysicalSpawnReceipt,
        trusted: &TrustedRunnerConfig,
        spawned_at_unix_ms: i64,
    ) -> Option<Self> {
        (receipt.metadata() == &plan.metadata()).then(|| Self {
            payload: wire::AttemptProcessSpawned {
                identity: Some(identity_to_wire(plan.identity())),
                runner_provenance: Some(runtime_provenance(plan, receipt.process_id(), trusted)),
                resource_group_id: receipt.metadata().resource_group_id.0.clone(),
                reservation_id: receipt.reservation_id().into(),
                endpoint_ids: plan.endpoint_ids().to_vec(),
                spawned_at_unix_ms,
            },
        })
    }

    pub(in crate::management) fn to_wire(&self) -> wire::ManagementPayload {
        wire::ManagementPayload {
            body: Some(wire::management_payload::Body::AttemptProcessSpawned(
                self.payload.clone(),
            )),
        }
    }
}

#[derive(Debug)]
pub(in crate::management) struct AttemptContainmentFact {
    payload: wire::AttemptContainmentReport,
}

impl AttemptContainmentFact {
    pub(super) fn new(
        plan: &LaunchPlan,
        receipt: &PhysicalSpawnReceipt,
        reported_at_unix_ms: i64,
    ) -> Option<Self> {
        (receipt.metadata() == &plan.metadata()).then(|| Self {
            payload: wire::AttemptContainmentReport {
                identity: Some(identity_to_wire(plan.identity())),
                runtime_instance_id: plan.runtime_instance_id().into(),
                requested_budget: Some(plan.budget_wire()),
                effective_containment: Some(containment_to_wire(receipt.containment_report())),
                reported_at_unix_ms,
            },
        })
    }

    pub(in crate::management) fn to_wire(&self) -> wire::ManagementPayload {
        wire::ManagementPayload {
            body: Some(wire::management_payload::Body::AttemptContainmentReport(
                self.payload.clone(),
            )),
        }
    }
}

pub(super) const fn authority_rejection(
    plan: &LaunchPlan,
    now_unix_ms: i64,
) -> Option<LaunchRejection> {
    if now_unix_ms >= plan.hard_deadline_at_unix_ms() {
        Some(LaunchRejection::InvalidDeadline)
    } else if now_unix_ms >= plan.authority_lease_expires_at_unix_ms() {
        Some(LaunchRejection::StaleAuthority)
    } else {
        None
    }
}
