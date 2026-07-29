use std::collections::HashSet;

use crate::generated::v1 as wire;
use crate::management_channel::{ManagementChannelError, ManagementSessionPolicy};

use super::super::{bounded_time, valid_text};

pub(in crate::management_channel::channel::validation) fn validate_runtime_provenance(
    value: Option<&wire::RuntimeProvenance>,
    policy: &ManagementSessionPolicy,
    payload: &'static str,
) -> Result<(), ManagementChannelError> {
    let value = value.ok_or(ManagementChannelError::InvalidManagementPayload {
        payload,
        field: "runner_provenance",
    })?;
    for (field, text) in [
        ("runner_build_id", value.build_id.as_str()),
        ("runner_source_commit", value.source_commit.as_str()),
        ("runtime_instance_id", value.runtime_instance_id.as_str()),
        ("runner_operating_system", value.operating_system.as_str()),
        ("runner_architecture", value.architecture.as_str()),
    ] {
        valid_text(text, payload, field)?;
    }
    if value.binary_sha256.len() != 32 || value.pid == 0 || !policy.permits_runner_provenance(value)
    {
        return super::super::invalid(payload, "runner_provenance");
    }
    Ok(())
}

pub(super) fn validate_containment(
    value: Option<&wire::ContainmentReport>,
    payload: &'static str,
) -> Result<(), ManagementChannelError> {
    let value = value.ok_or(ManagementChannelError::InvalidManagementPayload {
        payload,
        field: "effective_containment",
    })?;
    let level = wire::ContainmentLevel::try_from(value.level).map_err(|_| {
        ManagementChannelError::InvalidManagementPayload {
            payload,
            field: "containment_level",
        }
    })?;
    let capabilities =
        value
            .capabilities
            .as_ref()
            .ok_or(ManagementChannelError::InvalidManagementPayload {
                payload,
                field: "effective_containment",
            })?;
    if level == wire::ContainmentLevel::Unspecified {
        return super::super::invalid(payload, "effective_containment");
    }
    let mut seen = HashSet::new();
    for item in &value.enforced_limits {
        let limit = parse_unique_limit(*item, &mut seen, payload)?;
        if mapped_capability(*capabilities, limit) == Some(false) {
            return super::super::invalid(payload, "effective_containment");
        }
    }
    for item in &value.unsupported_limits {
        let limit = parse_unique_limit(*item, &mut seen, payload)?;
        if mapped_capability(*capabilities, limit) == Some(true) {
            return super::super::invalid(payload, "effective_containment");
        }
    }
    // V1 deliberately has no "supported but not applied" state: every budget
    // limit is classified exactly once, and mapped capabilities describe the
    // physical result rather than an abstract platform feature inventory.
    if seen.len() != 7 || !level_matches_capabilities(level, *capabilities, value) {
        return super::super::invalid(payload, "effective_containment");
    }
    Ok(())
}

fn parse_unique_limit(
    value: i32,
    seen: &mut HashSet<wire::ResourceLimitKind>,
    payload: &'static str,
) -> Result<wire::ResourceLimitKind, ManagementChannelError> {
    let limit = wire::ResourceLimitKind::try_from(value).map_err(|_| {
        ManagementChannelError::InvalidManagementPayload {
            payload,
            field: "containment_limits",
        }
    })?;
    if limit == wire::ResourceLimitKind::Unspecified || !seen.insert(limit) {
        return super::super::invalid(payload, "containment_limits");
    }
    Ok(limit)
}

const fn mapped_capability(
    capabilities: wire::ContainmentCapabilities,
    limit: wire::ResourceLimitKind,
) -> Option<bool> {
    match limit {
        wire::ResourceLimitKind::Memory => Some(capabilities.memory_limit),
        wire::ResourceLimitKind::CpuTime => Some(capabilities.cpu_limit),
        wire::ResourceLimitKind::Processes => {
            Some(capabilities.process_tree && capabilities.process_count_limit)
        }
        wire::ResourceLimitKind::OpenHandles => Some(capabilities.open_file_limit),
        wire::ResourceLimitKind::ScratchBytes => Some(capabilities.filesystem_quota),
        wire::ResourceLimitKind::Threads => Some(false),
        wire::ResourceLimitKind::WallTime | wire::ResourceLimitKind::Unspecified => None,
    }
}

const fn level_matches_capabilities(
    level: wire::ContainmentLevel,
    capabilities: wire::ContainmentCapabilities,
    report: &wire::ContainmentReport,
) -> bool {
    match level {
        wire::ContainmentLevel::HardAggregate | wire::ContainmentLevel::HardProcess => {
            capabilities.process_tree
        }
        wire::ContainmentLevel::Monitored => true,
        wire::ContainmentLevel::Unavailable => {
            report.enforced_limits.is_empty()
                && !capabilities.process_tree
                && !capabilities.memory_limit
                && !capabilities.cpu_limit
                && !capabilities.process_count_limit
                && !capabilities.open_file_limit
                && !capabilities.filesystem_quota
                && !capabilities.network_policy
        }
        wire::ContainmentLevel::Unspecified => false,
    }
}

pub(in crate::management_channel::channel::validation) fn validate_resource_sample(
    value: Option<&wire::ResourceSample>,
    payload: &'static str,
    field: &'static str,
) -> Result<(), ManagementChannelError> {
    let value = value.ok_or(ManagementChannelError::InvalidManagementPayload { payload, field })?;
    if value.peak_resident_memory_bytes < value.resident_memory_bytes {
        return super::super::invalid(payload, field);
    }
    Ok(())
}

pub(in crate::management_channel::channel::validation) const fn validate_supervisor_resource_sample(
    value: &wire::SupervisorResourceSample,
    policy: &ManagementSessionPolicy,
    observed_at: i64,
) -> Result<(), ManagementChannelError> {
    if value.active_attempts > policy.limits().max_active_attempts
        || value.pending_launches > policy.limits().max_pending_launches
        || value.reserved_memory_bytes > policy.limits().max_reserved_memory_bytes
        || value.process_count > policy.limits().max_reserved_processes
        || value.peak_resident_memory_bytes < value.resident_memory_bytes
    {
        return super::super::invalid("SupervisorResourceSample", "resource_values");
    }
    bounded_time(
        value.sampled_at_unix_ms,
        observed_at,
        "SupervisorResourceSample",
        "sampled_at",
    )
}

pub(super) fn validate_released_resources(
    values: &[wire::ReleasedResource],
) -> Result<(), ManagementChannelError> {
    if values.is_empty() {
        return super::super::invalid("AttemptProcessReaped", "released_resources");
    }
    let mut kinds = HashSet::with_capacity(values.len());
    for value in values {
        let kind = wire::ReleasedResourceKind::try_from(value.kind).map_err(|_| {
            ManagementChannelError::InvalidManagementPayload {
                payload: "AttemptProcessReaped",
                field: "released_resources",
            }
        })?;
        valid_text(
            &value.resource_id,
            "AttemptProcessReaped",
            "released_resources",
        )?;
        if kind == wire::ReleasedResourceKind::Unspecified
            || value.released_count == 0
            || !kinds.insert(kind)
        {
            return super::super::invalid("AttemptProcessReaped", "released_resources");
        }
    }
    if !kinds.contains(&wire::ReleasedResourceKind::Process)
        || !kinds.contains(&wire::ReleasedResourceKind::ResourceGroup)
    {
        return super::super::invalid("AttemptProcessReaped", "released_resources");
    }
    Ok(())
}
