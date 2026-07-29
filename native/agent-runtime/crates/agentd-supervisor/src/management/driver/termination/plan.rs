use agent_protocol::identity::AttemptIdentity;
use agent_protocol::management_channel::ValidatedManagementPayload;
use agent_protocol::wire_identity::identity_from_wire;

use super::model::{PhysicalCleanupCause, PhysicalTerminationKind, PhysicalTerminationPlan};
use crate::process_table::{AttemptRuntimeMetadata, OwnershipKey};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TerminationPlanError {
    Identity,
    Unsupported,
    InvalidDeadline,
    DeadlineOverflow,
    RuntimeMismatch,
}

#[derive(Clone)]
pub(in crate::management::driver) struct TerminationCommand {
    pub(super) identity: AttemptIdentity,
    pub(super) kind: PhysicalTerminationKind,
    pub(super) cause: PhysicalCleanupCause,
    pub(super) idempotency_key: String,
    pub(super) payload_digest: [u8; 32],
    timing: TerminationTiming,
}

#[derive(Clone)]
enum TerminationTiming {
    Cancel {
        grace_deadline_at_unix_ms: i64,
    },
    Fence,
    Reap {
        runtime_instance_id: String,
        reap_deadline_at_unix_ms: i64,
    },
}

impl TerminationCommand {
    pub(super) fn from_validated(
        payload: &ValidatedManagementPayload,
        payload_digest: [u8; 32],
    ) -> Result<Self, TerminationPlanError> {
        if let Some(value) = payload.cancel_attempt_process() {
            return Ok(Self {
                identity: parse_identity(value.identity.as_ref())?,
                kind: PhysicalTerminationKind::Cancel,
                cause: PhysicalCleanupCause::Cancelled {
                    reason_code: value.reason_code.clone(),
                },
                idempotency_key: value.idempotency_key.clone(),
                payload_digest,
                timing: TerminationTiming::Cancel {
                    grace_deadline_at_unix_ms: value.grace_deadline_at_unix_ms,
                },
            });
        }
        if let Some(value) = payload.fence_attempt_process() {
            return Ok(Self {
                identity: parse_identity(value.identity.as_ref())?,
                kind: PhysicalTerminationKind::Fence,
                cause: PhysicalCleanupCause::Fenced {
                    reason_code: value.reason_code.clone(),
                    replacement_fencing_epoch: value.replacement_fencing_epoch,
                },
                idempotency_key: value.idempotency_key.clone(),
                payload_digest,
                timing: TerminationTiming::Fence,
            });
        }
        let Some(value) = payload.reap_attempt_process() else {
            return Err(TerminationPlanError::Unsupported);
        };
        Ok(Self {
            identity: parse_identity(value.identity.as_ref())?,
            kind: PhysicalTerminationKind::Reap,
            cause: PhysicalCleanupCause::ReapRequested {
                reason_code: value.reason_code.clone(),
            },
            idempotency_key: value.idempotency_key.clone(),
            payload_digest,
            timing: TerminationTiming::Reap {
                runtime_instance_id: value.runtime_instance_id.clone(),
                reap_deadline_at_unix_ms: value.reap_deadline_at_unix_ms,
            },
        })
    }

    pub(super) fn bind(
        &self,
        metadata: &AttemptRuntimeMetadata,
        ownership_key: OwnershipKey,
        observed_at_unix_ms: i64,
    ) -> Result<PhysicalTerminationPlan, TerminationPlanError> {
        if metadata.identity != self.identity {
            return Err(TerminationPlanError::Identity);
        }
        let (terminate_at, hard_cleanup_deadline) = match &self.timing {
            TerminationTiming::Cancel {
                grace_deadline_at_unix_ms,
            } => {
                let maximum = bounded_grace_deadline(metadata, observed_at_unix_ms)?;
                if *grace_deadline_at_unix_ms <= observed_at_unix_ms
                    || *grace_deadline_at_unix_ms > maximum
                {
                    return Err(TerminationPlanError::InvalidDeadline);
                }
                (*grace_deadline_at_unix_ms, None)
            }
            TerminationTiming::Fence => (
                bounded_grace_deadline(metadata, observed_at_unix_ms)?.max(observed_at_unix_ms),
                None,
            ),
            TerminationTiming::Reap {
                runtime_instance_id,
                reap_deadline_at_unix_ms,
            } => {
                if runtime_instance_id != metadata.runtime_instance_id.as_str() {
                    return Err(TerminationPlanError::RuntimeMismatch);
                }
                if *reap_deadline_at_unix_ms <= observed_at_unix_ms {
                    return Err(TerminationPlanError::InvalidDeadline);
                }
                (observed_at_unix_ms, Some(*reap_deadline_at_unix_ms))
            }
        };
        Ok(PhysicalTerminationPlan::new(
            self.kind,
            ownership_key,
            terminate_at,
            hard_cleanup_deadline,
        ))
    }

    pub(in crate::management::driver) const fn identity(&self) -> &AttemptIdentity {
        &self.identity
    }

    pub(in crate::management::driver) const fn kind(&self) -> PhysicalTerminationKind {
        self.kind
    }

    pub(in crate::management::driver) const fn cause(&self) -> &PhysicalCleanupCause {
        &self.cause
    }

    pub(in crate::management::driver) fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }

    pub(in crate::management::driver) const fn payload_digest(&self) -> &[u8; 32] {
        &self.payload_digest
    }
}

fn parse_identity(
    identity: Option<&agent_protocol::generated::v1::AttemptIdentity>,
) -> Result<AttemptIdentity, TerminationPlanError> {
    identity
        .ok_or(TerminationPlanError::Identity)
        .and_then(|value| identity_from_wire(value).map_err(|_| TerminationPlanError::Identity))
}

fn bounded_grace_deadline(
    metadata: &AttemptRuntimeMetadata,
    observed_at_unix_ms: i64,
) -> Result<i64, TerminationPlanError> {
    let grace = i64::try_from(metadata.cancel_grace_ms)
        .map_err(|_| TerminationPlanError::DeadlineOverflow)?;
    let budget_deadline = observed_at_unix_ms
        .checked_add(grace)
        .ok_or(TerminationPlanError::DeadlineOverflow)?;
    Ok(metadata.deadline_at_unix_ms.min(budget_deadline))
}
