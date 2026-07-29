use std::collections::BTreeSet;

use agent_protocol::generated::v1 as wire;

use super::error::ControlError;
use super::launch::RunnerLaunchContext;
use super::manifest::{
    validate_artifact_manifest, validate_artifacts, validate_snapshot_manifest, validate_snapshots,
};
use super::model::EffectivePreparedFacts;

pub(super) fn validate_hydrated_facts(
    facts: &EffectivePreparedFacts,
    launch: &RunnerLaunchContext,
    expected_snapshots: &[wire::SnapshotRef],
    expected_artifacts: &[wire::ArtifactRef],
    prepare_accepted_at_unix_ms: i64,
    attempt_deadline_at_unix_ms: i64,
    now_unix_ms: i64,
) -> Result<(), ControlError> {
    validate_budget_reason(&facts.resource_budget)
        .map_err(ControlError::InvalidEffectiveResourceBudget)?;
    if facts.resource_budget != *launch.resource_budget() {
        return Err(ControlError::EffectiveResourceBudgetMismatch);
    }
    validate_containment(&facts.containment, launch)?;
    validate_snapshots(&facts.loaded_snapshots, "loaded_snapshots")?;
    validate_snapshot_manifest(
        &facts.loaded_snapshots,
        expected_snapshots,
        "loaded_snapshots",
    )?;
    validate_artifacts(
        &facts.validated_artifacts,
        launch.identity().session_id.as_str(),
        Some(launch.resource_budget()),
    )?;
    validate_artifact_manifest(
        &facts.validated_artifacts,
        expected_artifacts,
        launch.identity().session_id.as_str(),
        launch.resource_budget(),
    )?;
    if now_unix_ms <= 0
        || facts.ready_at_unix_ms < prepare_accepted_at_unix_ms
        || facts.ready_at_unix_ms > now_unix_ms
    {
        return Err(ControlError::InvalidReadyAtUnixMs(facts.ready_at_unix_ms));
    }
    if now_unix_ms >= attempt_deadline_at_unix_ms {
        return Err(ControlError::AttemptDeadlineExpired {
            deadline: attempt_deadline_at_unix_ms,
            now: now_unix_ms,
        });
    }
    Ok(())
}

pub(super) fn validate_budget_reason(budget: &wire::ResourceBudget) -> Result<(), &'static str> {
    for (field, value) in budget_values(budget) {
        if value == 0 {
            return Err(field);
        }
    }
    if budget.soft_memory_bytes > budget.hard_memory_bytes {
        return Err("soft_memory_bytes exceeds hard_memory_bytes");
    }
    if budget.max_artifact_bytes > budget.max_spool_bytes {
        return Err("max_artifact_bytes exceeds max_spool_bytes");
    }
    if budget.cancel_grace_ms > budget.max_wall_ms {
        return Err("cancel_grace_ms exceeds max_wall_ms");
    }
    Ok(())
}

fn budget_values(budget: &wire::ResourceBudget) -> [(&'static str, u64); 15] {
    [
        ("soft_memory_bytes", budget.soft_memory_bytes),
        ("hard_memory_bytes", budget.hard_memory_bytes),
        ("cpu_time_ms", budget.cpu_time_ms),
        ("max_wall_ms", budget.max_wall_ms),
        ("max_processes", u64::from(budget.max_processes)),
        ("max_threads", u64::from(budget.max_threads)),
        ("max_open_handles", u64::from(budget.max_open_handles)),
        ("max_hot_transcript_bytes", budget.max_hot_transcript_bytes),
        ("max_ipc_frames", u64::from(budget.max_ipc_frames)),
        ("max_ipc_bytes", budget.max_ipc_bytes),
        ("max_spool_bytes", budget.max_spool_bytes),
        ("max_artifact_bytes", budget.max_artifact_bytes),
        (
            "max_concurrent_tools",
            u64::from(budget.max_concurrent_tools),
        ),
        ("max_blocking_tasks", u64::from(budget.max_blocking_tasks)),
        ("cancel_grace_ms", budget.cancel_grace_ms),
    ]
}

pub(super) fn capabilities_support(
    capabilities: wire::ContainmentCapabilities,
    limits: &[wire::ResourceLimitKind],
) -> Result<(), ControlError> {
    for limit in limits {
        let supported = match limit {
            wire::ResourceLimitKind::Memory => capabilities.memory_limit,
            wire::ResourceLimitKind::CpuTime => capabilities.cpu_limit,
            wire::ResourceLimitKind::WallTime => true,
            wire::ResourceLimitKind::Processes => {
                capabilities.process_tree && capabilities.process_count_limit
            }
            wire::ResourceLimitKind::Threads | wire::ResourceLimitKind::Unspecified => false,
            wire::ResourceLimitKind::OpenHandles => capabilities.open_file_limit,
            wire::ResourceLimitKind::ScratchBytes => capabilities.filesystem_quota,
        };
        if !supported {
            return Err(ControlError::ContainmentCapabilityMismatch(*limit));
        }
    }
    Ok(())
}

fn validate_containment(
    report: &wire::ContainmentReport,
    launch: &RunnerLaunchContext,
) -> Result<(), ControlError> {
    let level = wire::ContainmentLevel::try_from(report.level)
        .map_err(|_| ControlError::InvalidEffectiveContainment("unknown level"))?;
    if !level_satisfies(level, launch.required_containment_level()) {
        return Err(ControlError::RequiredContainmentLevelMissing);
    }
    let capabilities =
        report
            .capabilities
            .as_ref()
            .ok_or(ControlError::InvalidEffectiveContainment(
                "capabilities are missing",
            ))?;
    if matches!(
        level,
        wire::ContainmentLevel::HardAggregate | wire::ContainmentLevel::HardProcess
    ) && !capabilities.process_tree
    {
        return Err(ControlError::InvalidEffectiveContainment(
            "hard containment requires process-tree ownership",
        ));
    }

    let enforced = limit_set(&report.enforced_limits)?;
    let unsupported = limit_set(&report.unsupported_limits)?;
    if !enforced.is_disjoint(&unsupported) {
        return Err(ControlError::InvalidEffectiveContainment(
            "enforced and unsupported limits overlap",
        ));
    }
    if enforced.len() + unsupported.len() != 7 {
        return Err(ControlError::InvalidEffectiveContainment(
            "containment limits do not form a complete partition",
        ));
    }
    for required in launch.required_enforced_limits() {
        if !enforced.contains(&(*required as i32)) {
            return Err(ControlError::RequiredContainmentLimitMissing(*required));
        }
    }
    let enforced_kinds = report
        .enforced_limits
        .iter()
        .map(|value| {
            wire::ResourceLimitKind::try_from(*value)
                .map_err(|_| ControlError::InvalidEffectiveContainment("unknown resource limit"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    capabilities_support(*capabilities, &enforced_kinds)?;
    for value in &report.unsupported_limits {
        let kind = wire::ResourceLimitKind::try_from(*value)
            .map_err(|_| ControlError::InvalidEffectiveContainment("unknown resource limit"))?;
        if capability_state(*capabilities, kind) == Some(true) {
            return Err(ControlError::InvalidEffectiveContainment(
                "unsupported limit has an applied capability",
            ));
        }
    }
    Ok(())
}

const fn capability_state(
    capabilities: wire::ContainmentCapabilities,
    limit: wire::ResourceLimitKind,
) -> Option<bool> {
    match limit {
        wire::ResourceLimitKind::Memory => Some(capabilities.memory_limit),
        wire::ResourceLimitKind::CpuTime => Some(capabilities.cpu_limit),
        wire::ResourceLimitKind::WallTime => None,
        wire::ResourceLimitKind::Processes => {
            Some(capabilities.process_tree && capabilities.process_count_limit)
        }
        wire::ResourceLimitKind::Threads | wire::ResourceLimitKind::Unspecified => Some(false),
        wire::ResourceLimitKind::OpenHandles => Some(capabilities.open_file_limit),
        wire::ResourceLimitKind::ScratchBytes => Some(capabilities.filesystem_quota),
    }
}

fn limit_set(values: &[i32]) -> Result<BTreeSet<i32>, ControlError> {
    let mut unique = BTreeSet::new();
    for value in values {
        let kind = wire::ResourceLimitKind::try_from(*value)
            .map_err(|_| ControlError::InvalidEffectiveContainment("unknown resource limit"))?;
        if kind == wire::ResourceLimitKind::Unspecified {
            return Err(ControlError::InvalidEffectiveContainment(
                "resource limit cannot be unspecified",
            ));
        }
        if !unique.insert(*value) {
            return Err(ControlError::InvalidEffectiveContainment(
                "resource limit is duplicated",
            ));
        }
    }
    Ok(unique)
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
        wire::ContainmentLevel::Monitored => !matches!(
            actual,
            wire::ContainmentLevel::Unspecified | wire::ContainmentLevel::Unavailable
        ),
        wire::ContainmentLevel::Unspecified | wire::ContainmentLevel::Unavailable => false,
    }
}
