use agent_protocol::frame::{CommittedInbound, InboundBinding};
use agent_protocol::handshake::HandshakeMachine;

use crate::lifecycle::RunnerLifecycle;

use super::authority::ActiveAuthority;

mod prepared;
mod termination;

pub(super) use prepared::{
    CommittedPrepared, PendingPreparation, PendingPrepared, PreparationState, PreparedCache,
    ValidatedPrepare,
};
pub use prepared::{EffectivePreparedFacts, HydrationToken, PrepareOutcome};
pub(super) use termination::{
    AcceptedTermination, CommittedTermination, PendingTermination, TerminationCache,
};
pub use termination::{CancelOutcome, CancelledAttempt, FenceOutcome, FencedAttempt};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivationOutcome {
    Activated,
    AlreadyActive,
}

#[derive(Debug)]
pub(super) struct ActivationCache {
    pub idempotency_key: String,
    pub frame_payload_sha256: [u8; 32],
}

#[derive(Debug)]
pub(super) enum PendingActivation {
    Fresh(Box<PendingFreshActivation>),
    Retry { binding: InboundBinding },
}

impl PendingActivation {
    // The receipt is a single-use capability and must be consumed here.
    #[allow(clippy::needless_pass_by_value)]
    pub(super) fn bind(self, receipt: CommittedInbound) -> Option<CommittedActivation> {
        let binding = match &self {
            Self::Fresh(fresh) => &fresh.binding,
            Self::Retry { binding } => binding,
        };
        if !receipt.matches(binding) {
            return None;
        }
        Some(match self {
            Self::Fresh(fresh) => CommittedActivation::Fresh(Box::new(FreshActivation {
                cache: fresh.cache,
                authority: fresh.authority,
                handshake: fresh.handshake,
                lifecycle: fresh.lifecycle,
            })),
            Self::Retry { .. } => CommittedActivation::Retry,
        })
    }
}

#[derive(Debug)]
pub(super) struct PendingFreshActivation {
    pub binding: InboundBinding,
    pub cache: ActivationCache,
    pub authority: ActiveAuthority,
    pub handshake: HandshakeMachine,
    pub lifecycle: RunnerLifecycle,
}

#[derive(Debug)]
pub(super) struct FreshActivation {
    pub cache: ActivationCache,
    pub authority: ActiveAuthority,
    pub handshake: HandshakeMachine,
    pub lifecycle: RunnerLifecycle,
}

#[derive(Debug)]
pub(super) enum CommittedActivation {
    Fresh(Box<FreshActivation>),
    Retry,
}
