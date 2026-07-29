use std::collections::HashSet;

use crate::generated::v1 as wire;

use super::{bounded_time, required_identity, valid_text};
use crate::management_channel::{ManagementChannelError, ManagementSessionPolicy};

mod semantic;

use semantic::{validate_containment, validate_released_resources};
pub(in crate::management_channel::channel::validation) use semantic::{
    validate_resource_sample, validate_runtime_provenance, validate_supervisor_resource_sample,
};

pub(super) fn validate(
    body: &wire::management_payload::Body,
    policy: &ManagementSessionPolicy,
    observed_at: i64,
) -> Result<(), ManagementChannelError> {
    use wire::management_payload::Body;

    match body {
        Body::AttemptProcessSpawned(value) => validate_spawned(value, policy, observed_at),
        Body::AttemptContainmentReport(value) => {
            validate_containment_report(value, policy, observed_at)
        }
        Body::AttemptProcessExited(value) => validate_exited(value, policy, observed_at),
        Body::AttemptProcessReaped(value) => validate_reaped(value, observed_at),
        Body::SupervisorResourceSample(value) => validate_supervisor_sample(value, observed_at),
        _ => unreachable!("non-fact routed to fact validation"),
    }
}

fn validate_spawned(
    value: &wire::AttemptProcessSpawned,
    policy: &ManagementSessionPolicy,
    observed_at: i64,
) -> Result<(), ManagementChannelError> {
    required_identity(value.identity.as_ref(), "AttemptProcessSpawned")?;
    validate_runtime_provenance(
        value.runner_provenance.as_ref(),
        policy,
        "AttemptProcessSpawned",
    )?;
    valid_text(
        &value.resource_group_id,
        "AttemptProcessSpawned",
        "resource_group_id",
    )?;
    valid_text(
        &value.reservation_id,
        "AttemptProcessSpawned",
        "reservation_id",
    )?;
    if value.endpoint_ids.len() != 3 {
        return super::invalid("AttemptProcessSpawned", "endpoint_ids");
    }
    let mut endpoint_ids = HashSet::with_capacity(value.endpoint_ids.len());
    for endpoint_id in &value.endpoint_ids {
        valid_text(endpoint_id, "AttemptProcessSpawned", "endpoint_ids")?;
        if !endpoint_ids.insert(endpoint_id) {
            return super::invalid("AttemptProcessSpawned", "endpoint_ids");
        }
    }
    bounded_time(
        value.spawned_at_unix_ms,
        observed_at,
        "AttemptProcessSpawned",
        "spawned_at",
    )
}

fn validate_containment_report(
    value: &wire::AttemptContainmentReport,
    policy: &ManagementSessionPolicy,
    observed_at: i64,
) -> Result<(), ManagementChannelError> {
    required_identity(value.identity.as_ref(), "AttemptContainmentReport")?;
    valid_text(
        &value.runtime_instance_id,
        "AttemptContainmentReport",
        "runtime_instance_id",
    )?;
    let budget = value.requested_budget.as_ref().ok_or(
        ManagementChannelError::InvalidManagementPayload {
            payload: "AttemptContainmentReport",
            field: "requested_budget",
        },
    )?;
    super::super::launch::validate_budget(budget, policy, None)?;
    validate_containment(
        value.effective_containment.as_ref(),
        "AttemptContainmentReport",
    )?;
    bounded_time(
        value.reported_at_unix_ms,
        observed_at,
        "AttemptContainmentReport",
        "reported_at",
    )
}

fn validate_exited(
    value: &wire::AttemptProcessExited,
    policy: &ManagementSessionPolicy,
    observed_at: i64,
) -> Result<(), ManagementChannelError> {
    required_identity(value.identity.as_ref(), "AttemptProcessExited")?;
    validate_runtime_provenance(
        value.runner_provenance.as_ref(),
        policy,
        "AttemptProcessExited",
    )?;
    if wire::PhysicalExitCause::try_from(value.cause).is_err()
        || value.cause == wire::PhysicalExitCause::Unspecified as i32
    {
        return super::invalid("AttemptProcessExited", "cause");
    }
    validate_resource_sample(
        value.final_resources.as_ref(),
        "AttemptProcessExited",
        "final_resources",
    )?;
    bounded_time(
        value.exited_at_unix_ms,
        observed_at,
        "AttemptProcessExited",
        "exited_at",
    )
}

fn validate_reaped(
    value: &wire::AttemptProcessReaped,
    observed_at: i64,
) -> Result<(), ManagementChannelError> {
    required_identity(value.identity.as_ref(), "AttemptProcessReaped")?;
    valid_text(
        &value.runtime_instance_id,
        "AttemptProcessReaped",
        "runtime_instance_id",
    )?;
    valid_text(
        &value.resource_group_id,
        "AttemptProcessReaped",
        "resource_group_id",
    )?;
    validate_released_resources(&value.released_resources)?;
    bounded_time(
        value.reaped_at_unix_ms,
        observed_at,
        "AttemptProcessReaped",
        "reaped_at",
    )
}

const fn validate_supervisor_sample(
    value: &wire::SupervisorResourceSample,
    observed_at: i64,
) -> Result<(), ManagementChannelError> {
    if value.peak_resident_memory_bytes < value.resident_memory_bytes {
        return super::invalid("SupervisorResourceSample", "resident_memory");
    }
    bounded_time(
        value.sampled_at_unix_ms,
        observed_at,
        "SupervisorResourceSample",
        "sampled_at",
    )
}
