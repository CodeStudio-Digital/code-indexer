use std::collections::HashSet;

use crate::generated::v1 as wire;

use super::super::RunnerBootstrapError;
use super::super::error::invalid;

const HANDOFF: &str = "RunnerLaunchHandoff";

pub(super) fn validate_budget(
    value: Option<&wire::ResourceBudget>,
) -> Result<(), RunnerBootstrapError> {
    let value = value.ok_or_else(|| invalid(HANDOFF, "reserved_resource_budget"))?;
    let nonzero = value.soft_memory_bytes > 0
        && value.hard_memory_bytes > 0
        && value.cpu_time_ms > 0
        && value.max_wall_ms > 0
        && value.max_processes > 0
        && value.max_threads > 0
        && value.max_open_handles > 0
        && value.max_hot_transcript_bytes > 0
        && value.max_ipc_frames > 0
        && value.max_ipc_bytes > 0
        && value.max_spool_bytes > 0
        && value.max_artifact_bytes > 0
        && value.max_concurrent_tools > 0
        && value.max_blocking_tasks > 0
        && value.cancel_grace_ms > 0;
    let consistent = value.soft_memory_bytes <= value.hard_memory_bytes
        && value.max_threads >= value.max_processes
        && value.max_artifact_bytes <= value.max_spool_bytes
        && value.cancel_grace_ms <= value.max_wall_ms;
    if !nonzero || !consistent {
        return Err(invalid(HANDOFF, "reserved_resource_budget"));
    }
    Ok(())
}

pub(super) fn validate_containment(
    value: Option<&wire::ContainmentReport>,
) -> Result<(), RunnerBootstrapError> {
    let value = value.ok_or_else(|| invalid(HANDOFF, "effective_containment"))?;
    let level = wire::ContainmentLevel::try_from(value.level)
        .map_err(|_| invalid(HANDOFF, "containment.level"))?;
    let capabilities = value
        .capabilities
        .as_ref()
        .ok_or_else(|| invalid(HANDOFF, "containment.capabilities"))?;
    if matches!(
        level,
        wire::ContainmentLevel::Unspecified | wire::ContainmentLevel::Unavailable
    ) {
        return Err(invalid(HANDOFF, "containment.level"));
    }
    let mut seen = HashSet::new();
    for raw in &value.enforced_limits {
        let limit = insert_limit(*raw, &mut seen)?;
        if mapped_capability(*capabilities, limit) == Some(false) {
            return Err(invalid(HANDOFF, "containment.enforced_limits"));
        }
    }
    for raw in &value.unsupported_limits {
        let limit = insert_limit(*raw, &mut seen)?;
        if mapped_capability(*capabilities, limit) == Some(true) {
            return Err(invalid(HANDOFF, "containment.unsupported_limits"));
        }
    }
    if seen.len() != 7
        || matches!(
            level,
            wire::ContainmentLevel::HardAggregate | wire::ContainmentLevel::HardProcess
        ) && !capabilities.process_tree
    {
        return Err(invalid(HANDOFF, "effective_containment"));
    }
    Ok(())
}

fn insert_limit(
    raw: i32,
    seen: &mut HashSet<wire::ResourceLimitKind>,
) -> Result<wire::ResourceLimitKind, RunnerBootstrapError> {
    let limit = wire::ResourceLimitKind::try_from(raw)
        .map_err(|_| invalid(HANDOFF, "containment.limits"))?;
    if limit == wire::ResourceLimitKind::Unspecified || !seen.insert(limit) {
        return Err(invalid(HANDOFF, "containment.limits"));
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
