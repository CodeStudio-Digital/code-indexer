use std::collections::HashSet;

use agent_protocol::generated::v1 as wire;

use crate::HostBridgeError;

const ALL_LIMITS: [wire::ResourceLimitKind; 7] = [
    wire::ResourceLimitKind::Memory,
    wire::ResourceLimitKind::CpuTime,
    wire::ResourceLimitKind::WallTime,
    wire::ResourceLimitKind::Processes,
    wire::ResourceLimitKind::Threads,
    wire::ResourceLimitKind::OpenHandles,
    wire::ResourceLimitKind::ScratchBytes,
];

pub const fn validate_budget(value: &wire::ResourceBudget) -> Result<(), HostBridgeError> {
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
    let ordered = value.soft_memory_bytes <= value.hard_memory_bytes
        && value.max_threads >= value.max_processes
        && value.max_artifact_bytes <= value.max_spool_bytes
        && value.cancel_grace_ms <= value.max_wall_ms;
    if !nonzero || !ordered {
        return Err(HostBridgeError::InvalidRequest("resource_budget"));
    }
    Ok(())
}

pub fn provenance_matches(
    expected: &wire::ExpectedRuntimeProvenance,
    actual: &wire::RuntimeProvenance,
) -> bool {
    valid_text(&expected.build_id)
        && valid_text(&expected.source_commit)
        && expected.binary_sha256.len() == 32
        && valid_text(&expected.operating_system)
        && valid_text(&expected.architecture)
        && expected.build_id == actual.build_id
        && expected.source_commit == actual.source_commit
        && expected.binary_sha256 == actual.binary_sha256
        && expected.operating_system == actual.operating_system
        && expected.architecture == actual.architecture
        && valid_text(&actual.runtime_instance_id)
        && actual.pid > 0
}

pub fn validate_containment(
    value: &wire::ContainmentReport,
    required_level: i32,
    required_limits: &[i32],
) -> Result<(), HostBridgeError> {
    let required_level = level(required_level)?;
    let actual_level = level(value.level)?;
    if !level_satisfies(actual_level, required_level) || value.capabilities.is_none() {
        return invalid_containment();
    }
    let required = limit_set(required_limits)?;
    if required.is_empty() {
        return invalid_containment();
    }
    let enforced = limit_set(&value.enforced_limits)?;
    let unsupported = limit_set(&value.unsupported_limits)?;
    if enforced.len() + unsupported.len() != ALL_LIMITS.len()
        || enforced.iter().any(|item| unsupported.contains(item))
        || required.iter().any(|item| !enforced.contains(item))
    {
        return invalid_containment();
    }
    let capabilities = value.capabilities.as_ref().expect("checked presence");
    for item in &enforced {
        if capability_state(*capabilities, *item) == Some(false) {
            return invalid_containment();
        }
    }
    for item in &unsupported {
        if capability_state(*capabilities, *item) == Some(true) {
            return invalid_containment();
        }
    }
    Ok(())
}

fn level(value: i32) -> Result<wire::ContainmentLevel, HostBridgeError> {
    match wire::ContainmentLevel::try_from(value) {
        Ok(
            level @ (wire::ContainmentLevel::HardAggregate
            | wire::ContainmentLevel::HardProcess
            | wire::ContainmentLevel::Monitored),
        ) => Ok(level),
        _ => invalid_containment(),
    }
}

const fn level_satisfies(actual: wire::ContainmentLevel, required: wire::ContainmentLevel) -> bool {
    match required {
        wire::ContainmentLevel::HardAggregate => {
            matches!(actual, wire::ContainmentLevel::HardAggregate)
        }
        wire::ContainmentLevel::HardProcess => matches!(
            actual,
            wire::ContainmentLevel::HardAggregate | wire::ContainmentLevel::HardProcess
        ),
        wire::ContainmentLevel::Monitored => true,
        _ => false,
    }
}

fn limit_set(values: &[i32]) -> Result<HashSet<wire::ResourceLimitKind>, HostBridgeError> {
    let mut output = HashSet::with_capacity(values.len());
    for raw in values {
        let value = wire::ResourceLimitKind::try_from(*raw)
            .map_err(|_| HostBridgeError::InvalidRequest("containment"))?;
        if value == wire::ResourceLimitKind::Unspecified || !output.insert(value) {
            return invalid_containment();
        }
    }
    Ok(output)
}

const fn capability_state(
    value: wire::ContainmentCapabilities,
    limit: wire::ResourceLimitKind,
) -> Option<bool> {
    match limit {
        wire::ResourceLimitKind::Memory => Some(value.memory_limit),
        wire::ResourceLimitKind::CpuTime => Some(value.cpu_limit),
        wire::ResourceLimitKind::WallTime => None,
        wire::ResourceLimitKind::Processes => Some(value.process_tree && value.process_count_limit),
        wire::ResourceLimitKind::OpenHandles => Some(value.open_file_limit),
        wire::ResourceLimitKind::ScratchBytes => Some(value.filesystem_quota),
        wire::ResourceLimitKind::Threads | wire::ResourceLimitKind::Unspecified => Some(false),
    }
}

fn valid_text(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 512 && !value.as_bytes().contains(&0)
}

const fn invalid_containment<T>() -> Result<T, HostBridgeError> {
    Err(HostBridgeError::InvalidRequest("containment"))
}
