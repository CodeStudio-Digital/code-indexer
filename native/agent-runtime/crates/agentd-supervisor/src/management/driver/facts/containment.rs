use agent_platform::containment::{ContainmentLevel, ContainmentReport, LimitKind, ProcessId};
use agent_protocol::generated::v1 as wire;

use super::super::config::TrustedRunnerConfig;
use super::super::plan::LaunchPlan;

pub(in crate::management::driver) fn report_satisfies(
    report: &ContainmentReport,
    required_level: wire::ContainmentLevel,
    required_limits: &[LimitKind],
) -> bool {
    report_is_coherent(report)
        && containment_rank(report.level) >= wire_containment_rank(required_level)
        && required_limits
            .iter()
            .all(|required| report.enforced_limits.contains(required))
}

pub(super) fn runtime_provenance(
    plan: &LaunchPlan,
    process_id: ProcessId,
    trusted: &TrustedRunnerConfig,
) -> wire::RuntimeProvenance {
    trusted
        .provenance()
        .to_runtime_wire(plan.runtime_instance_id(), process_id.0)
}

pub(in crate::management::driver) fn containment_to_wire(
    report: &ContainmentReport,
) -> wire::ContainmentReport {
    wire::ContainmentReport {
        level: containment_level_to_wire(report.level) as i32,
        enforced_limits: report
            .enforced_limits
            .iter()
            .map(|item| limit_to_wire(*item))
            .collect(),
        unsupported_limits: report
            .unsupported_limits
            .iter()
            .map(|item| limit_to_wire(*item))
            .collect(),
        capabilities: Some(wire::ContainmentCapabilities {
            process_tree: report.capabilities.process_tree,
            memory_limit: report.capabilities.memory_limit,
            cpu_limit: report.capabilities.cpu_limit,
            process_count_limit: report.capabilities.process_count_limit,
            open_file_limit: report.capabilities.open_file_limit,
            filesystem_quota: report.capabilities.filesystem_quota,
            network_policy: report.capabilities.network_policy,
        }),
    }
}

fn report_is_coherent(report: &ContainmentReport) -> bool {
    let complete_partition = ALL_LIMITS.iter().all(|limit| {
        report
            .enforced_limits
            .iter()
            .filter(|item| *item == limit)
            .count()
            + report
                .unsupported_limits
                .iter()
                .filter(|item| *item == limit)
                .count()
            == 1
    });
    let mapped_limits_match = ALL_LIMITS.iter().all(|limit| {
        mapped_capability(report, *limit)
            .is_none_or(|supported| supported == report.enforced_limits.contains(limit))
    });
    let level_matches = match report.level {
        ContainmentLevel::HardAggregate | ContainmentLevel::HardProcess => {
            report.capabilities.process_tree
        }
        ContainmentLevel::Monitored => true,
        ContainmentLevel::Unavailable => {
            report.enforced_limits.is_empty()
                && report.capabilities
                    == agent_platform::containment::ContainmentCapabilities::default()
        }
    };
    complete_partition && mapped_limits_match && level_matches
}

const fn mapped_capability(report: &ContainmentReport, limit: LimitKind) -> Option<bool> {
    match limit {
        LimitKind::Memory => Some(report.capabilities.memory_limit),
        LimitKind::CpuTime => Some(report.capabilities.cpu_limit),
        LimitKind::WallTime => None,
        LimitKind::Processes => {
            Some(report.capabilities.process_tree && report.capabilities.process_count_limit)
        }
        LimitKind::Threads => Some(false),
        LimitKind::OpenHandles => Some(report.capabilities.open_file_limit),
        LimitKind::ScratchBytes => Some(report.capabilities.filesystem_quota),
    }
}

const ALL_LIMITS: [LimitKind; 7] = [
    LimitKind::Memory,
    LimitKind::CpuTime,
    LimitKind::WallTime,
    LimitKind::Processes,
    LimitKind::Threads,
    LimitKind::OpenHandles,
    LimitKind::ScratchBytes,
];

const fn containment_rank(level: ContainmentLevel) -> u8 {
    match level {
        ContainmentLevel::HardAggregate => 4,
        ContainmentLevel::HardProcess => 3,
        ContainmentLevel::Monitored => 2,
        ContainmentLevel::Unavailable => 1,
    }
}

const fn wire_containment_rank(level: wire::ContainmentLevel) -> u8 {
    match level {
        wire::ContainmentLevel::HardAggregate => 4,
        wire::ContainmentLevel::HardProcess => 3,
        wire::ContainmentLevel::Monitored => 2,
        wire::ContainmentLevel::Unavailable => 1,
        wire::ContainmentLevel::Unspecified => 0,
    }
}

const fn containment_level_to_wire(level: ContainmentLevel) -> wire::ContainmentLevel {
    match level {
        ContainmentLevel::HardAggregate => wire::ContainmentLevel::HardAggregate,
        ContainmentLevel::HardProcess => wire::ContainmentLevel::HardProcess,
        ContainmentLevel::Monitored => wire::ContainmentLevel::Monitored,
        ContainmentLevel::Unavailable => wire::ContainmentLevel::Unavailable,
    }
}

const fn limit_to_wire(limit: LimitKind) -> i32 {
    match limit {
        LimitKind::Memory => wire::ResourceLimitKind::Memory as i32,
        LimitKind::CpuTime => wire::ResourceLimitKind::CpuTime as i32,
        LimitKind::WallTime => wire::ResourceLimitKind::WallTime as i32,
        LimitKind::Processes => wire::ResourceLimitKind::Processes as i32,
        LimitKind::Threads => wire::ResourceLimitKind::Threads as i32,
        LimitKind::OpenHandles => wire::ResourceLimitKind::OpenHandles as i32,
        LimitKind::ScratchBytes => wire::ResourceLimitKind::ScratchBytes as i32,
    }
}
