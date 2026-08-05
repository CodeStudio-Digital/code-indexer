use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::sync::Arc;

use agent_protocol::activation_authority::activation_nonce_sha256;
use agent_protocol::identity::{AttemptIdentity, ConnectionId, RuntimeInstanceId};
#[cfg(test)]
use agent_protocol::semantic_hash::semantic_sha256;

mod gate;

#[cfg(test)]
pub use gate::EffectDispatchPermit;
pub use gate::{EffectClock, EffectGate};

#[cfg(test)]
const ACTIVE_AUTHORITY_SCHEMA_ID: &str = "codestudio.agent.v1.ActiveAuthority";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthorityError {
    NotActive,
    Revoked,
    Expired { deadline: i64, now: i64 },
    InvalidToken,
    ClockRegressed { previous: i64, observed: i64 },
    GatePoisoned,
}

impl Display for AuthorityError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotActive => formatter.write_str("attempt authority is not active"),
            Self::Revoked => formatter.write_str("attempt authority is revoked"),
            Self::Expired { deadline, now } => {
                write!(
                    formatter,
                    "attempt authority deadline {deadline} expired at {now}"
                )
            }
            Self::InvalidToken => formatter.write_str("effect token is invalid"),
            Self::ClockRegressed { previous, observed } => write!(
                formatter,
                "effect clock regressed from {previous} to {observed}"
            ),
            Self::GatePoisoned => formatter.write_str("effect dispatch gate is poisoned"),
        }
    }
}

impl Error for AuthorityError {}

/// Durable authority retained after a validated Activate.
#[derive(Debug)]
pub struct ActiveAuthority {
    identity: AttemptIdentity,
    runtime_instance_id: RuntimeInstanceId,
    connection_id: ConnectionId,
    agent_run_version: u64,
    attempt_version: u64,
    deadline_at_unix_ms: i64,
    spec_sha256: [u8; 32],
    activation_nonce_sha256: [u8; 32],
    #[cfg(test)]
    authority_tag: [u8; 32],
}

impl ActiveAuthority {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn new(
        identity: AttemptIdentity,
        runtime_instance_id: RuntimeInstanceId,
        connection_id: ConnectionId,
        agent_run_version: u64,
        attempt_version: u64,
        deadline_at_unix_ms: i64,
        spec_sha256: [u8; 32],
        activation_nonce: &[u8],
    ) -> Self {
        let activation_nonce_sha256 = activation_nonce_sha256(activation_nonce);
        #[cfg(test)]
        let authority_tag = authority_tag(
            &identity,
            &runtime_instance_id,
            &connection_id,
            agent_run_version,
            attempt_version,
            deadline_at_unix_ms,
            &spec_sha256,
            &activation_nonce_sha256,
        );
        Self {
            identity,
            runtime_instance_id,
            connection_id,
            agent_run_version,
            attempt_version,
            deadline_at_unix_ms,
            spec_sha256,
            activation_nonce_sha256,
            #[cfg(test)]
            authority_tag,
        }
    }

    #[must_use]
    pub const fn identity(&self) -> &AttemptIdentity {
        &self.identity
    }

    #[must_use]
    pub const fn runtime_instance_id(&self) -> &RuntimeInstanceId {
        &self.runtime_instance_id
    }

    #[must_use]
    pub const fn connection_id(&self) -> &ConnectionId {
        &self.connection_id
    }

    #[must_use]
    pub const fn agent_run_version(&self) -> u64 {
        self.agent_run_version
    }

    #[must_use]
    pub const fn attempt_version(&self) -> u64 {
        self.attempt_version
    }

    #[must_use]
    pub const fn deadline_at_unix_ms(&self) -> i64 {
        self.deadline_at_unix_ms
    }

    #[must_use]
    pub const fn spec_sha256(&self) -> &[u8; 32] {
        &self.spec_sha256
    }

    #[must_use]
    pub const fn activation_nonce_sha256(&self) -> &[u8; 32] {
        &self.activation_nonce_sha256
    }

    pub(super) fn effect_gate(&self, clock: Arc<dyn EffectClock>) -> EffectGate {
        EffectGate::new(self, clock)
    }
}

/// Non-cloneable capability required by future provider/tool dispatch.
#[cfg(test)]
#[derive(Debug)]
pub struct EffectToken {
    gate_identity: Arc<GateIdentity>,
    generation: u64,
    fencing_epoch: u64,
    authority_tag: [u8; 32],
}

#[cfg(test)]
#[derive(Debug)]
struct GateIdentity;

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn authority_tag(
    identity: &AttemptIdentity,
    runtime: &RuntimeInstanceId,
    connection: &ConnectionId,
    run_version: u64,
    attempt_version: u64,
    deadline: i64,
    spec_sha256: &[u8; 32],
    nonce_sha256: &[u8; 32],
) -> [u8; 32] {
    let mut bytes = Vec::with_capacity(4_096);
    for value in [
        identity.session_id.as_str(),
        identity.command_id.as_str(),
        identity.agent_run_id.as_str(),
        identity.attempt_id.as_str(),
        identity.executor_owner_id.as_str(),
        identity.correlation_id.as_str(),
        identity.root_agent_run_id.as_str(),
        identity
            .owner_agent_run_id
            .as_ref()
            .map_or("", |value| value.as_str()),
        identity
            .parent_agent_run_id
            .as_ref()
            .map_or("", |value| value.as_str()),
        runtime.as_str(),
        connection.as_str(),
    ] {
        let length = u32::try_from(value.len()).unwrap_or(u32::MAX);
        bytes.extend_from_slice(&length.to_be_bytes());
        bytes.extend_from_slice(value.as_bytes());
    }
    bytes.extend_from_slice(&identity.fencing_epoch.to_be_bytes());
    bytes.extend_from_slice(&run_version.to_be_bytes());
    bytes.extend_from_slice(&attempt_version.to_be_bytes());
    bytes.extend_from_slice(&deadline.to_be_bytes());
    bytes.extend_from_slice(spec_sha256);
    bytes.extend_from_slice(nonce_sha256);
    semantic_sha256(ACTIVE_AUTHORITY_SCHEMA_ID, 1, &bytes)
        .expect("fixed ActiveAuthority semantic hash coordinates are valid")
}
