use agent_protocol::frame::{CommittedInbound, InboundBinding};
use agent_protocol::generated::v1 as wire;

use crate::lifecycle::RunnerLifecycle;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CancelledAttempt {
    reason: wire::CancelReason,
    reason_code: String,
    grace_deadline_at_unix_ms: i64,
}

impl CancelledAttempt {
    pub(in crate::control) const fn new(
        reason: wire::CancelReason,
        reason_code: String,
        grace_deadline_at_unix_ms: i64,
    ) -> Self {
        Self {
            reason,
            reason_code,
            grace_deadline_at_unix_ms,
        }
    }

    #[must_use]
    pub const fn reason(&self) -> wire::CancelReason {
        self.reason
    }

    #[must_use]
    pub fn reason_code(&self) -> &str {
        &self.reason_code
    }

    #[must_use]
    pub const fn grace_deadline_at_unix_ms(&self) -> i64 {
        self.grace_deadline_at_unix_ms
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CancelOutcome {
    Accepted(CancelledAttempt),
    AlreadyAccepted(CancelledAttempt),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FencedAttempt {
    replacement_fencing_epoch: u64,
    reason_code: String,
    fenced_at_unix_ms: i64,
}

impl FencedAttempt {
    pub(in crate::control) const fn new(
        replacement_fencing_epoch: u64,
        reason_code: String,
        fenced_at_unix_ms: i64,
    ) -> Self {
        Self {
            replacement_fencing_epoch,
            reason_code,
            fenced_at_unix_ms,
        }
    }

    #[must_use]
    pub const fn replacement_fencing_epoch(&self) -> u64 {
        self.replacement_fencing_epoch
    }

    #[must_use]
    pub fn reason_code(&self) -> &str {
        &self.reason_code
    }

    #[must_use]
    pub const fn fenced_at_unix_ms(&self) -> i64 {
        self.fenced_at_unix_ms
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FenceOutcome {
    Accepted(FencedAttempt),
    AlreadyAccepted(FencedAttempt),
}

#[derive(Debug, Clone)]
pub(in crate::control) struct TerminationCache<T> {
    pub(in crate::control) idempotency_key: String,
    pub(in crate::control) frame_payload_sha256: [u8; 32],
    pub(in crate::control) attempt: T,
}

impl<T> TerminationCache<T> {
    pub(in crate::control) fn matches(&self, idempotency_key: &str, digest: &[u8; 32]) -> bool {
        self.idempotency_key == idempotency_key && self.frame_payload_sha256 == *digest
    }
}

#[derive(Debug)]
pub(in crate::control) enum AcceptedTermination {
    Cancel(TerminationCache<CancelledAttempt>),
    Fence(TerminationCache<FencedAttempt>),
}

#[derive(Debug)]
pub(in crate::control) struct PendingTermination<T> {
    binding: InboundBinding,
    transition: PendingTerminationTransition<T>,
}

#[derive(Debug)]
enum PendingTerminationTransition<T> {
    Fresh {
        cache: TerminationCache<T>,
        lifecycle: Box<RunnerLifecycle>,
    },
    Retry {
        attempt: T,
    },
}

impl<T> PendingTermination<T> {
    pub(in crate::control) fn fresh(
        binding: InboundBinding,
        cache: TerminationCache<T>,
        lifecycle: RunnerLifecycle,
    ) -> Self {
        Self {
            binding,
            transition: PendingTerminationTransition::Fresh {
                cache,
                lifecycle: Box::new(lifecycle),
            },
        }
    }

    pub(in crate::control) const fn retry(binding: InboundBinding, attempt: T) -> Self {
        Self {
            binding,
            transition: PendingTerminationTransition::Retry { attempt },
        }
    }

    // The receipt is a single-use capability and must be consumed here.
    #[allow(clippy::needless_pass_by_value)]
    pub(in crate::control) fn bind(
        self,
        receipt: CommittedInbound,
    ) -> Option<CommittedTermination<T>> {
        if !receipt.matches(&self.binding) {
            return None;
        }
        Some(match self.transition {
            PendingTerminationTransition::Fresh { cache, lifecycle } => {
                CommittedTermination::Fresh { cache, lifecycle }
            }
            PendingTerminationTransition::Retry { attempt } => {
                CommittedTermination::Retry { attempt }
            }
        })
    }
}

#[derive(Debug)]
pub(in crate::control) enum CommittedTermination<T> {
    Fresh {
        cache: TerminationCache<T>,
        lifecycle: Box<RunnerLifecycle>,
    },
    Retry {
        attempt: T,
    },
}
