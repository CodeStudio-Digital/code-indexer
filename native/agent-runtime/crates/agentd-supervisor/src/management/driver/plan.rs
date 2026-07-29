use agent_platform::budget::ResourceBudget;
use agent_platform::containment::{LimitKind, ResourceGroupId};
use agent_protocol::generated::v1 as wire;
use agent_protocol::identity::{AttemptIdentity, RuntimeInstanceId};
use agent_protocol::semantic_hash::semantic_sha256;
use agent_protocol::wire_identity::identity_from_wire;

use super::config::TrustedRunnerConfig;
use super::provision::ProtectedEndpointSeal;
use crate::process_table::{AttemptRuntimeMetadata, OwnershipKey};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LaunchPlanError {
    Identity,
    RuntimeIdentity,
    ExpectedProvenance,
    ResourceLimit,
    SecretDigest,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LaunchPlan {
    identity: AttemptIdentity,
    budget: ResourceBudget,
    budget_wire: wire::ResourceBudget,
    hard_deadline_at_unix_ms: i64,
    authority_lease_expires_at_unix_ms: i64,
    runtime_instance_id: RuntimeInstanceId,
    resource_group_id: ResourceGroupId,
    required_limits: Vec<LimitKind>,
    endpoint_ids: Vec<String>,
    endpoint_seals: Vec<ProtectedEndpointSeal>,
    idempotency_key: String,
    expected_runner_provenance: wire::ExpectedRuntimeProvenance,
    launch_nonce_digest: [u8; 32],
    payload_digest: [u8; 32],
}

impl LaunchPlan {
    pub(super) fn from_validated(
        launch: &wire::LaunchAttemptProcess,
        payload_digest: [u8; 32],
    ) -> Result<Self, LaunchPlanError> {
        let identity =
            identity_from_wire(launch.identity.as_ref().ok_or(LaunchPlanError::Identity)?)
                .map_err(|_| LaunchPlanError::Identity)?;
        let expected_runner_provenance = launch
            .expected_runner_provenance
            .clone()
            .ok_or(LaunchPlanError::ExpectedProvenance)?;
        let budget_wire = launch.resource_budget.ok_or(LaunchPlanError::Identity)?;
        let budget = resource_budget(budget_wire);
        let required_limits = launch
            .required_enforced_limits
            .iter()
            .map(|value| {
                wire::ResourceLimitKind::try_from(*value)
                    .ok()
                    .and_then(limit_from_wire)
                    .ok_or(LaunchPlanError::ResourceLimit)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let runtime_instance_id =
            RuntimeInstanceId::new(format!("runtime:{}", hex_prefix(&payload_digest, 16)))
                .map_err(|_| LaunchPlanError::RuntimeIdentity)?;
        let resource_group_id =
            ResourceGroupId(format!("attempt-group:{}", hex_prefix(&payload_digest, 16)));
        let launch_nonce_digest =
            semantic_sha256("codestudio.agent.launch-nonce", 1, &launch.launch_nonce)
                .map_err(|_| LaunchPlanError::SecretDigest)?;
        Ok(Self {
            identity,
            budget,
            budget_wire,
            hard_deadline_at_unix_ms: launch.hard_deadline_at_unix_ms,
            authority_lease_expires_at_unix_ms: launch.authority_lease_expires_at_unix_ms,
            runtime_instance_id,
            resource_group_id,
            required_limits,
            endpoint_ids: launch
                .protected_endpoints
                .iter()
                .map(|endpoint| endpoint.endpoint_id.clone())
                .collect(),
            endpoint_seals: launch
                .protected_endpoints
                .iter()
                .map(ProtectedEndpointSeal::from_wire)
                .collect(),
            idempotency_key: launch.idempotency_key.clone(),
            expected_runner_provenance,
            launch_nonce_digest,
            payload_digest,
        })
    }

    pub(super) fn metadata(&self) -> AttemptRuntimeMetadata {
        AttemptRuntimeMetadata {
            identity: self.identity.clone(),
            runtime_instance_id: self.runtime_instance_id.clone(),
            resource_group_id: self.resource_group_id.clone(),
            deadline_at_unix_ms: self.hard_deadline_at_unix_ms,
            lease_expires_at_unix_ms: self.authority_lease_expires_at_unix_ms,
            cancel_grace_ms: self.budget.cancel_grace_ms,
        }
    }

    pub(super) fn ownership_key(&self) -> OwnershipKey {
        OwnershipKey::from_metadata(&self.metadata())
    }

    pub(super) const fn identity(&self) -> &AttemptIdentity {
        &self.identity
    }

    pub(super) const fn budget(&self) -> &ResourceBudget {
        &self.budget
    }

    pub(super) const fn budget_wire(&self) -> wire::ResourceBudget {
        self.budget_wire
    }

    pub(super) const fn hard_deadline_at_unix_ms(&self) -> i64 {
        self.hard_deadline_at_unix_ms
    }

    pub(super) const fn authority_lease_expires_at_unix_ms(&self) -> i64 {
        self.authority_lease_expires_at_unix_ms
    }

    pub(super) fn runtime_instance_id(&self) -> &str {
        self.runtime_instance_id.as_str()
    }

    pub(super) fn required_limits(&self) -> &[LimitKind] {
        &self.required_limits
    }

    pub(super) fn endpoint_ids(&self) -> &[String] {
        &self.endpoint_ids
    }

    pub(super) fn endpoint_seals(&self) -> &[ProtectedEndpointSeal] {
        &self.endpoint_seals
    }

    pub(super) fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }

    pub(super) fn trusted_provenance_matches(&self, trusted: &TrustedRunnerConfig) -> bool {
        trusted
            .provenance()
            .matches(&self.expected_runner_provenance)
    }

    pub(super) const fn expected_runner_provenance(&self) -> &wire::ExpectedRuntimeProvenance {
        &self.expected_runner_provenance
    }

    pub(super) const fn launch_nonce_digest(&self) -> &[u8; 32] {
        &self.launch_nonce_digest
    }

    pub(super) const fn payload_digest(&self) -> &[u8; 32] {
        &self.payload_digest
    }
}

const fn resource_budget(value: wire::ResourceBudget) -> ResourceBudget {
    ResourceBudget {
        soft_memory_bytes: value.soft_memory_bytes,
        hard_memory_bytes: value.hard_memory_bytes,
        cpu_time_ms: value.cpu_time_ms,
        max_wall_ms: value.max_wall_ms,
        max_processes: value.max_processes,
        max_threads: value.max_threads,
        max_open_handles: value.max_open_handles,
        max_hot_transcript_bytes: value.max_hot_transcript_bytes,
        max_ipc_frames: value.max_ipc_frames,
        max_ipc_bytes: value.max_ipc_bytes,
        max_spool_bytes: value.max_spool_bytes,
        max_artifact_bytes: value.max_artifact_bytes,
        max_concurrent_tools: value.max_concurrent_tools,
        max_blocking_tasks: value.max_blocking_tasks,
        cancel_grace_ms: value.cancel_grace_ms,
    }
}

const fn limit_from_wire(value: wire::ResourceLimitKind) -> Option<LimitKind> {
    match value {
        wire::ResourceLimitKind::Memory => Some(LimitKind::Memory),
        wire::ResourceLimitKind::CpuTime => Some(LimitKind::CpuTime),
        wire::ResourceLimitKind::WallTime => Some(LimitKind::WallTime),
        wire::ResourceLimitKind::Processes => Some(LimitKind::Processes),
        wire::ResourceLimitKind::Threads => Some(LimitKind::Threads),
        wire::ResourceLimitKind::OpenHandles => Some(LimitKind::OpenHandles),
        wire::ResourceLimitKind::ScratchBytes => Some(LimitKind::ScratchBytes),
        wire::ResourceLimitKind::Unspecified => None,
    }
}

fn hex_prefix(bytes: &[u8; 32], count: usize) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(count * 2);
    for byte in bytes.iter().take(count) {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}
