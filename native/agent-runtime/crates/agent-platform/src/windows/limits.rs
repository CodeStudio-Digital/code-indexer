use crate::budget::ResourceBudget;
use crate::containment::{ContainmentCapabilities, ContainmentLevel, ContainmentReport, LimitKind};
use windows_sys::Win32::System::JobObjects::{
    JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_JOB_TIME,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_TERMINATE_AT_END_OF_JOB,
    JOBOBJECT_END_OF_JOB_TIME_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
};

use super::WindowsContainmentError;

const HUNDRED_NS_TICKS_PER_MS: u64 = 10_000;

pub(super) struct JobLimits {
    pub extended: JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    pub end_of_job: JOBOBJECT_END_OF_JOB_TIME_INFORMATION,
}

impl JobLimits {
    pub(super) fn from_budget(budget: &ResourceBudget) -> Result<Self, WindowsContainmentError> {
        let memory = usize::try_from(budget.hard_memory_bytes)
            .map_err(|_| WindowsContainmentError::LimitOverflow("hard_memory_bytes"))?;
        let cpu_ticks = budget
            .cpu_time_ms
            .checked_mul(HUNDRED_NS_TICKS_PER_MS)
            .and_then(|ticks| i64::try_from(ticks).ok())
            .ok_or(WindowsContainmentError::LimitOverflow("cpu_time_ms"))?;

        let mut extended = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        extended.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_JOB_MEMORY
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_JOB_TIME
            | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        extended.BasicLimitInformation.ActiveProcessLimit = budget.max_processes;
        extended.BasicLimitInformation.PerJobUserTimeLimit = cpu_ticks;
        extended.JobMemoryLimit = memory;

        Ok(Self {
            extended,
            end_of_job: JOBOBJECT_END_OF_JOB_TIME_INFORMATION {
                EndOfJobTimeAction: JOB_OBJECT_TERMINATE_AT_END_OF_JOB,
            },
        })
    }

    pub(super) fn report() -> ContainmentReport {
        // Windows `Memory` here is the hard aggregate committed virtual-memory
        // limit (`JobMemoryLimit`), not RSS/working set. `CpuTime` is aggregate
        // user-mode time. `soft_memory_bytes` is not enforced by this adapter.
        ContainmentReport {
            level: ContainmentLevel::HardAggregate,
            enforced_limits: vec![LimitKind::Memory, LimitKind::CpuTime, LimitKind::Processes],
            unsupported_limits: vec![
                LimitKind::WallTime,
                LimitKind::Threads,
                LimitKind::OpenHandles,
                LimitKind::ScratchBytes,
            ],
            capabilities: ContainmentCapabilities {
                process_tree: true,
                memory_limit: true,
                cpu_limit: true,
                process_count_limit: true,
                ..ContainmentCapabilities::default()
            },
        }
    }
}
