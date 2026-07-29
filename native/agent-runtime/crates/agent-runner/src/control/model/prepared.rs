use agent_protocol::frame::{CommittedResponse, InboundBinding};
use agent_protocol::generated::v1 as wire;
use agent_protocol::handshake::HandshakeMachine;
use agent_protocol::identity::AttemptIdentity;

use crate::lifecycle::RunnerLifecycle;

/// Platform facts produced after a validated Prepare authorizes hydration.
///
/// Fields and construction are crate-private so wire input cannot forge proof
/// that snapshots, artifacts, budgets, or OS containment were verified.
#[derive(Debug)]
pub struct EffectivePreparedFacts {
    pub(in crate::control) loaded_snapshots: Vec<wire::SnapshotRef>,
    pub(in crate::control) validated_artifacts: Vec<wire::ArtifactRef>,
    pub(in crate::control) resource_budget: wire::ResourceBudget,
    pub(in crate::control) containment: wire::ContainmentReport,
    pub(in crate::control) ready_at_unix_ms: i64,
}

impl EffectivePreparedFacts {
    #[allow(dead_code)]
    pub(crate) const fn from_verified_platform(
        loaded_snapshots: Vec<wire::SnapshotRef>,
        validated_artifacts: Vec<wire::ArtifactRef>,
        resource_budget: wire::ResourceBudget,
        containment: wire::ContainmentReport,
        ready_at_unix_ms: i64,
    ) -> Self {
        Self {
            loaded_snapshots,
            validated_artifacts,
            resource_budget,
            containment,
            ready_at_unix_ms,
        }
    }
}

#[derive(Debug)]
pub enum PrepareOutcome {
    HydrationRequired(HydrationToken),
    HydrationInProgress,
    AlreadyPrepared,
}

/// Non-forgeable, non-cloneable capability for one validated hydration.
#[derive(Debug)]
pub struct HydrationToken {
    pub(in crate::control) seal: u64,
    pub(in crate::control) inbound_binding: InboundBinding,
    pub(in crate::control) expected_snapshots: Vec<wire::SnapshotRef>,
    pub(in crate::control) expected_artifacts: Vec<wire::ArtifactRef>,
}

impl HydrationToken {
    #[must_use]
    pub fn expected_snapshots(&self) -> &[wire::SnapshotRef] {
        &self.expected_snapshots
    }

    #[must_use]
    pub fn expected_artifacts(&self) -> &[wire::ArtifactRef] {
        &self.expected_artifacts
    }
}

#[derive(Debug)]
pub(in crate::control) struct ValidatedPrepare {
    pub identity: AttemptIdentity,
    pub wire_identity: wire::AttemptIdentity,
    pub immutable_deadline_at_unix_ms: i64,
    pub spec_sha256: [u8; 32],
    pub expected_snapshots: Vec<wire::SnapshotRef>,
    pub expected_artifacts: Vec<wire::ArtifactRef>,
}

#[derive(Debug)]
pub(in crate::control) struct PendingPreparation {
    pub idempotency_key: String,
    pub frame_payload_sha256: [u8; 32],
    pub seal: u64,
    pub inbound_binding: InboundBinding,
    pub accepted_at_unix_ms: i64,
    pub immutable_deadline_at_unix_ms: i64,
    pub spec_sha256: [u8; 32],
    pub wire_identity: wire::AttemptIdentity,
}

#[derive(Debug)]
struct StagedPreparedCache {
    idempotency_key: String,
    frame_payload_sha256: [u8; 32],
    immutable_deadline_at_unix_ms: i64,
    spec_sha256: [u8; 32],
    wire_identity: wire::AttemptIdentity,
    response: wire::FramePayload,
}

#[derive(Debug)]
pub(in crate::control) struct PreparedCache {
    pub idempotency_key: String,
    pub frame_payload_sha256: [u8; 32],
    pub immutable_deadline_at_unix_ms: i64,
    pub spec_sha256: [u8; 32],
    pub wire_identity: wire::AttemptIdentity,
    pub response: wire::FramePayload,
}

#[derive(Debug)]
pub(in crate::control) enum PreparationState {
    Hydrating(Box<PendingPreparation>),
    Prepared(Box<PreparedCache>),
}

#[derive(Debug)]
pub(in crate::control) struct PendingPrepared {
    binding: InboundBinding,
    cache: StagedPreparedCache,
    handshake: HandshakeMachine,
    lifecycle: RunnerLifecycle,
}

impl PendingPrepared {
    pub(in crate::control) fn new(
        pending: &PendingPreparation,
        response: wire::FramePayload,
        handshake: HandshakeMachine,
        lifecycle: RunnerLifecycle,
    ) -> Self {
        Self {
            binding: pending.inbound_binding.clone(),
            cache: StagedPreparedCache {
                idempotency_key: pending.idempotency_key.clone(),
                frame_payload_sha256: pending.frame_payload_sha256,
                immutable_deadline_at_unix_ms: pending.immutable_deadline_at_unix_ms,
                spec_sha256: pending.spec_sha256,
                wire_identity: pending.wire_identity.clone(),
                response,
            },
            handshake,
            lifecycle,
        }
    }

    pub(in crate::control) const fn response(&self) -> &wire::FramePayload {
        &self.cache.response
    }

    pub(in crate::control) const fn deadline_at_unix_ms(&self) -> i64 {
        self.cache.immutable_deadline_at_unix_ms
    }

    pub(in crate::control) fn bind(
        self,
        committed: CommittedResponse,
    ) -> Option<CommittedPrepared> {
        let receipt = committed.into_receipt();
        receipt.matches(&self.binding).then_some(CommittedPrepared {
            cache: PreparedCache {
                idempotency_key: self.cache.idempotency_key,
                frame_payload_sha256: self.cache.frame_payload_sha256,
                immutable_deadline_at_unix_ms: self.cache.immutable_deadline_at_unix_ms,
                spec_sha256: self.cache.spec_sha256,
                wire_identity: self.cache.wire_identity,
                response: self.cache.response,
            },
            handshake: self.handshake,
            lifecycle: self.lifecycle,
        })
    }
}

#[derive(Debug)]
pub(in crate::control) struct CommittedPrepared {
    pub cache: PreparedCache,
    pub handshake: HandshakeMachine,
    pub lifecycle: RunnerLifecycle,
}
