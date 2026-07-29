use std::fmt::{self, Debug, Formatter};

use agent_protocol::identity::AttemptIdentity;

pub struct DurableHostAttemptBinding {
    pub(crate) identity: AttemptIdentity,
    pub(crate) reservation_id: String,
    pub(crate) resource_group_id: String,
    pub(crate) runtime_instance_id: String,
    pub(crate) runner_pid: u32,
    pub(crate) hard_deadline_at_unix_ms: i64,
}

impl DurableHostAttemptBinding {
    #[must_use]
    pub const fn identity(&self) -> &AttemptIdentity {
        &self.identity
    }

    #[must_use]
    pub fn reservation_id(&self) -> &str {
        &self.reservation_id
    }

    #[must_use]
    pub fn resource_group_id(&self) -> &str {
        &self.resource_group_id
    }

    #[must_use]
    pub fn runtime_instance_id(&self) -> &str {
        &self.runtime_instance_id
    }

    #[must_use]
    pub const fn runner_pid(&self) -> u32 {
        self.runner_pid
    }

    #[must_use]
    pub const fn hard_deadline_at_unix_ms(&self) -> i64 {
        self.hard_deadline_at_unix_ms
    }
}

impl Debug for DurableHostAttemptBinding {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DurableHostAttemptBinding")
            .field("identity", &"[REDACTED]")
            .field("reservation_id", &"[REDACTED]")
            .field("resource_group_id", &"[REDACTED]")
            .field("runtime_instance_id", &"[REDACTED]")
            .field("runner_pid", &self.runner_pid)
            .field("hard_deadline_at_unix_ms", &self.hard_deadline_at_unix_ms)
            .finish()
    }
}
