use crate::process_table::OwnershipKey;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::management::driver) enum PhysicalTerminationKind {
    Cancel,
    Fence,
    Reap,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::management::driver) enum PhysicalCleanupCause {
    Cancelled {
        reason_code: String,
    },
    Fenced {
        reason_code: String,
        replacement_fencing_epoch: u64,
    },
    ReapRequested {
        reason_code: String,
    },
}

#[derive(Debug, Clone)]
pub(super) struct PhysicalTerminationPlan {
    ownership_key: OwnershipKey,
    kind: PhysicalTerminationKind,
    terminate_at_unix_ms: i64,
    hard_cleanup_deadline_at_unix_ms: Option<i64>,
}

impl PhysicalTerminationPlan {
    pub(super) const fn new(
        kind: PhysicalTerminationKind,
        ownership_key: OwnershipKey,
        terminate_at_unix_ms: i64,
        hard_cleanup_deadline_at_unix_ms: Option<i64>,
    ) -> Self {
        Self {
            ownership_key,
            kind,
            terminate_at_unix_ms,
            hard_cleanup_deadline_at_unix_ms,
        }
    }

    pub(super) const fn ownership_key(&self) -> &OwnershipKey {
        &self.ownership_key
    }

    pub(super) const fn kind(&self) -> PhysicalTerminationKind {
        self.kind
    }

    pub(super) const fn terminate_at_unix_ms(&self) -> i64 {
        self.terminate_at_unix_ms
    }

    pub(super) const fn hard_cleanup_deadline_at_unix_ms(&self) -> Option<i64> {
        self.hard_cleanup_deadline_at_unix_ms
    }
}
