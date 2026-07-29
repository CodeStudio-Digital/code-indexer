use std::error::Error;
use std::fmt::{self, Display, Formatter};

/// Explicit per-attempt limits. There is intentionally no `Default`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceBudget {
    pub soft_memory_bytes: u64,
    pub hard_memory_bytes: u64,
    pub cpu_time_ms: u64,
    pub max_wall_ms: u64,
    pub max_processes: u32,
    pub max_threads: u32,
    pub max_open_handles: u32,
    pub max_hot_transcript_bytes: u64,
    pub max_ipc_frames: u32,
    pub max_ipc_bytes: u64,
    pub max_spool_bytes: u64,
    pub max_artifact_bytes: u64,
    pub max_concurrent_tools: u32,
    pub max_blocking_tasks: u32,
    pub cancel_grace_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetError {
    ZeroLimit(&'static str),
    SoftMemoryExceedsHardMemory,
    ArtifactExceedsSpool,
    CancelGraceExceedsWall,
}

impl Display for BudgetError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::ZeroLimit(field) => write!(formatter, "resource limit {field} cannot be zero"),
            Self::SoftMemoryExceedsHardMemory => {
                formatter.write_str("soft memory limit exceeds hard memory limit")
            }
            Self::ArtifactExceedsSpool => formatter.write_str("artifact limit exceeds spool limit"),
            Self::CancelGraceExceedsWall => {
                formatter.write_str("cancel grace exceeds wall-time limit")
            }
        }
    }
}

impl Error for BudgetError {}

impl ResourceBudget {
    /// Validates that every limit is explicit and internally consistent.
    ///
    /// # Errors
    ///
    /// Returns [`BudgetError`] for zero limits, inverted memory watermarks, or
    /// an artifact limit larger than the spool.
    pub fn validate(&self) -> Result<(), BudgetError> {
        let nonzero = [
            ("soft_memory_bytes", self.soft_memory_bytes),
            ("hard_memory_bytes", self.hard_memory_bytes),
            ("cpu_time_ms", self.cpu_time_ms),
            ("max_wall_ms", self.max_wall_ms),
            ("max_processes", u64::from(self.max_processes)),
            ("max_threads", u64::from(self.max_threads)),
            ("max_open_handles", u64::from(self.max_open_handles)),
            ("max_hot_transcript_bytes", self.max_hot_transcript_bytes),
            ("max_ipc_frames", u64::from(self.max_ipc_frames)),
            ("max_ipc_bytes", self.max_ipc_bytes),
            ("max_spool_bytes", self.max_spool_bytes),
            ("max_artifact_bytes", self.max_artifact_bytes),
            ("max_concurrent_tools", u64::from(self.max_concurrent_tools)),
            ("max_blocking_tasks", u64::from(self.max_blocking_tasks)),
            ("cancel_grace_ms", self.cancel_grace_ms),
        ];
        if let Some((field, _)) = nonzero.into_iter().find(|(_, value)| *value == 0) {
            return Err(BudgetError::ZeroLimit(field));
        }
        if self.soft_memory_bytes > self.hard_memory_bytes {
            return Err(BudgetError::SoftMemoryExceedsHardMemory);
        }
        if self.max_artifact_bytes > self.max_spool_bytes {
            return Err(BudgetError::ArtifactExceedsSpool);
        }
        if self.cancel_grace_ms > self.max_wall_ms {
            return Err(BudgetError::CancelGraceExceedsWall);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{BudgetError, ResourceBudget};

    fn valid_budget() -> ResourceBudget {
        ResourceBudget {
            soft_memory_bytes: 64,
            hard_memory_bytes: 128,
            cpu_time_ms: 100,
            max_wall_ms: 500,
            max_processes: 2,
            max_threads: 4,
            max_open_handles: 16,
            max_hot_transcript_bytes: 128,
            max_ipc_frames: 8,
            max_ipc_bytes: 1024,
            max_spool_bytes: 1024,
            max_artifact_bytes: 512,
            max_concurrent_tools: 2,
            max_blocking_tasks: 2,
            cancel_grace_ms: 100,
        }
    }

    #[test]
    fn rejects_artifact_larger_than_spool() {
        let mut budget = valid_budget();
        budget.max_artifact_bytes = budget.max_spool_bytes + 1;
        assert_eq!(budget.validate(), Err(BudgetError::ArtifactExceedsSpool));
    }

    #[test]
    fn rejects_cancel_grace_larger_than_wall_time() {
        let mut budget = valid_budget();
        budget.cancel_grace_ms = budget.max_wall_ms + 1;
        assert_eq!(budget.validate(), Err(BudgetError::CancelGraceExceedsWall));
    }
}
