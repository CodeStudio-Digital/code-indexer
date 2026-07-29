use std::fmt::{self, Debug, Formatter};
use std::time::Duration;

use tokio::time::Instant;

use crate::frame::{AsyncEstablishedAttemptChannel, DataChannelLimits};
use crate::identity::{AttemptIdentity, ConnectionId, RuntimeInstanceId};
use crate::runner_bootstrap::RunnerEndpointTokenVerifier;
use crate::version::ProtocolVersion;

/// Single-use endpoint authority retained from the protected launch handoff.
pub struct RunnerDataBindAuthority {
    pub(super) identity: AttemptIdentity,
    pub(super) connection: ConnectionId,
    pub(super) protocol: ProtocolVersion,
    pub(super) runtime_instance_id: RuntimeInstanceId,
    pub(super) token_verifier: RunnerEndpointTokenVerifier,
    pub(super) limits: DataChannelLimits,
}

/// Absolute deadlines for the first bind transaction.
#[derive(Debug, Clone, Copy)]
pub struct DataBindDeadlines {
    pub read: Instant,
    pub replay_hard: Instant,
    pub replay_write_timeout: Duration,
    pub write: Instant,
    pub semantic_at_unix_ms: i64,
}

/// Physical stream whose first accepted operation must be `BindAttemptChannel`.
pub struct AsyncPendingDataAttemptChannel<S> {
    pub(super) channel: AsyncEstablishedAttemptChannel<S>,
    pub(super) authority: RunnerDataBindAuthority,
}

impl Debug for RunnerDataBindAuthority {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RunnerDataBindAuthority")
            .field("identity", &self.identity)
            .field("connection", &self.connection)
            .field("protocol", &self.protocol)
            .field("runtime_instance_id", &self.runtime_instance_id)
            .field("token_verifier", &"[REDACTED]")
            .field("limits", &self.limits)
            .finish()
    }
}

impl<S> Debug for AsyncPendingDataAttemptChannel<S> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AsyncPendingDataAttemptChannel")
            .field("channel", &self.channel)
            .field("authority", &self.authority)
            .finish()
    }
}
